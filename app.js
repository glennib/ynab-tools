import { convert, toYnabCsv } from "./convert.js";
import { YNAB_CLIENT_ID } from "./config.js";
import { Ynab, authorizeUrl, fromApiTransactions, parseRedirect, toApiTransactions } from "./ynab.js";

const $ = (id) => document.getElementById(id);

const amountFormat = new Intl.NumberFormat("nb-NO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "2026-10-23" -> "23.10.2026", the way the bank shows dates. */
function displayDate(iso) {
  const [year, month, day] = iso.split("-");
  return day ? `${day}.${month}.${year}` : iso;
}

function transactionCount(n) {
  return `${n} ${n === 1 ? "transaksjon" : "transaksjoner"}`;
}

// The token, and the last used plan and account, are kept in localStorage so they
// survive closing the tab; the token is dropped once it expires. The OAuth state and
// the converted file, with any excluded rows, live in sessionStorage: they survive
// the OAuth redirect and reloads, but the bank data is gone once the tab is closed.
const KEYS = {
  token: "handynab.token",
  state: "handynab.oauthState",
  conversion: "handynab.conversion",
  plan: "handynab.plan",
  account: "handynab.account",
  showSource: "handynab.showSource",
  showRecent: "handynab.showRecent",
};

function load(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function save(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode, blocked site data).
  }
}

let conversion = null; // { name, columns, transactions, pending, ignored }
let ynab = null;
let expiresAt = 0;

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

// --- Authentication -------------------------------------------------------

function redirectUri() {
  return location.origin + location.pathname;
}

function connect() {
  if (!YNAB_CLIENT_ID) {
    showError("Denne siden har ingen YNAB-klient-ID.");
    return;
  }
  const state = crypto.randomUUID();
  save(sessionStorage, KEYS.state, state);
  location.assign(authorizeUrl({ clientId: YNAB_CLIENT_ID, redirectUri: redirectUri(), state }));
}

function disconnect(message = "") {
  save(localStorage, KEYS.token, null);
  ynab = null;
  renderAuth();
  showError(message);
}

/** Picks up a token from the OAuth redirect, or a still valid stored one. */
function restoreSession() {
  const redirect = parseRedirect(location.hash);
  if (redirect) {
    history.replaceState(null, "", location.pathname + location.search);
    const expected = load(sessionStorage, KEYS.state);
    save(sessionStorage, KEYS.state, null);
    if (!expected || redirect.state !== expected) {
      showError("Svaret fra YNAB hørte ikke til denne økten. Prøv å koble til på nytt.");
    } else if (redirect.error) {
      showError(`Tilkoblingen til YNAB mislyktes: ${redirect.error}`);
    } else {
      save(localStorage, KEYS.token, { token: redirect.token, expiresAt: redirect.expiresAt });
    }
  }

  const stored = load(localStorage, KEYS.token);
  if (stored && stored.expiresAt > Date.now()) {
    ynab = new Ynab(stored.token);
    expiresAt = stored.expiresAt;
  } else {
    save(localStorage, KEYS.token, null);
  }

  conversion = load(sessionStorage, KEYS.conversion);
}

function renderAuth() {
  $("connect").hidden = Boolean(ynab);
  $("disconnect").hidden = !ynab;
  if (ynab) {
    const until = new Date(expiresAt).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
    $("auth-status").textContent = `Koblet til YNAB fram til kl. ${until}`;
  } else {
    $("auth-status").textContent = "Ikke koblet til YNAB";
  }
  $("ynab").hidden = !ynab;
  if (ynab) loadPlans();
  else loadRecent();
  updateImportButton();
}

/** Runs a YNAB call, dropping the session when the token is no longer accepted. */
async function call(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 401) disconnect("YNAB-tilkoblingen har utløpt. Koble til på nytt for å fortsette.");
    else showError(e.message);
    throw e;
  }
}

// --- Plan and account selection ------------------------------------------

function fillSelect(select, items, selectedId) {
  select.replaceChildren(
    ...items.map((item) => {
      const option = new Option(item.name, item.id);
      option.selected = item.id === selectedId;
      return option;
    }),
  );
}

async function loadPlans() {
  const { plans, defaultPlan } = await call(() => ynab.plans()).catch(() => ({ plans: [] }));
  const remembered = load(localStorage, KEYS.plan);
  const selected = plans.find((p) => p.id === remembered)?.id ?? defaultPlan?.id ?? plans[0]?.id;
  fillSelect($("plan"), plans, selected);
  await loadAccounts();
}

async function loadAccounts() {
  const planId = $("plan").value;
  if (!planId) {
    fillSelect($("account"), [], null);
    updateImportButton();
    return;
  }
  save(localStorage, KEYS.plan, planId);
  const accounts = await call(() => ynab.accounts(planId)).catch(() => []);
  // On-budget accounts first; tracking accounts are rarer import targets.
  accounts.sort((a, b) => Number(b.on_budget) - Number(a.on_budget));
  fillSelect($("account"), accounts, load(localStorage, KEYS.account));
  updateImportButton();
  loadRecent();
}

// --- Recent transactions in YNAB -------------------------------------------

let recentRequest = 0;
// The import_ids of the selected account's recent YNAB transactions. They reach
// back to the loaded file's first transaction, so every row in it can be checked.
let seenImportIds = new Set();

/**
 * The import_id of each transaction in the loaded file, in file order.
 * Excluded rows are still in the file, so they get one too.
 */
function fileImportIds() {
  const all = (conversion?.transactions ?? []).map(({ excluded, ...t }) => t);
  return toApiTransactions(all, $("account").value).map((t) => t.import_id);
}

/** Included transactions in the loaded file that are already in the selected account. */
function seenTransactions() {
  const ids = fileImportIds();
  return (conversion?.transactions ?? []).filter((t, i) => !t.excluded && seenImportIds.has(ids[i]));
}

function updateExcludeSeen() {
  const count = seenTransactions().length;
  $("exclude-seen").hidden = !count;
  $("exclude-seen").textContent = `Utelat ${count} som allerede er i YNAB`;
}

function excludeSeen() {
  for (const t of seenTransactions()) t.excluded = true;
  render();
}

/** The last 30 days, reaching back further when a loaded file starts earlier. */
function recentSince() {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const earliest = conversion?.transactions.map((t) => t.date).sort()[0];
  return earliest && earliest < monthAgo ? earliest : monthAgo;
}

/**
 * Lists the selected account's recent YNAB transactions. With a file loaded,
 * those that share an import_id with a row in it are marked.
 */
async function loadRecent() {
  // Changing account or file while a request is in flight makes its answer stale.
  const request = ++recentRequest;
  const planId = $("plan").value;
  const accountId = $("account").value;
  seenImportIds = new Set();
  updateExcludeSeen();
  if (!ynab || !accountId) {
    $("recent").hidden = true;
    return;
  }
  const since = recentSince();
  const transactions = await call(() => ynab.accountTransactions(planId, accountId, since)).catch(() => null);
  if (request !== recentRequest) return;
  if (!transactions) {
    $("recent").hidden = true;
    return;
  }

  const recent = fromApiTransactions(transactions);
  seenImportIds = new Set(recent.map((t) => t.importId).filter(Boolean));
  updateExcludeSeen();
  const inFile = new Set(fileImportIds());
  const fromFile = recent.filter((t) => inFile.has(t.importId)).length;
  const account = $("account").selectedOptions[0].textContent;
  const parts = [`${transactionCount(recent.length)} i ${account} siden ${displayDate(since)}`];
  if (fromFile) parts.push(`${fromFile} fra denne filen`);
  $("recent").querySelector("summary").textContent = parts.join(" · ");

  const head = headerRow([], false);
  head.append(Object.assign(document.createElement("th"), { textContent: "Status" }));
  $("recent-head").replaceChildren(head);
  const rows = transactionRows(recent, [], false);
  recent.forEach((t, i) => {
    const flags = [];
    if (inFile.has(t.importId)) flags.push("i denne filen");
    if (!t.approved) flags.push("ikke godkjent");
    if (t.cleared === "uncleared") flags.push("ikke klarert");
    rows[i].append(Object.assign(document.createElement("td"), { className: "flags", textContent: flags.join(", ") }));
  });
  $("recent-rows").replaceChildren(...rows);
  $("recent").hidden = false;
}

function updateImportButton() {
  const button = $("import");
  const count = conversion?.transactions.filter((t) => !t.excluded).length ?? 0;
  const account = $("account").selectedOptions[0];
  button.hidden = !conversion;
  button.disabled = !ynab || !count || !account;
  button.textContent = account
    ? `Importer ${transactionCount(count)} til ${account.textContent}`
    : "Importer";
}

async function importTransactions() {
  const planId = $("plan").value;
  const accountId = $("account").value;
  const status = $("import-status");
  save(localStorage, KEYS.account, accountId);
  showError("");
  $("import").disabled = true;
  status.hidden = false;
  status.textContent = "Importerer…";
  try {
    const transactions = toApiTransactions(conversion.transactions, accountId);
    const { created, duplicates } = await call(() => ynab.createTransactions(planId, transactions));
    const parts = [`${created} importert`];
    if (duplicates) parts.push(`${duplicates} fantes allerede i YNAB`);
    status.textContent = `${parts.join(" · ")}. Nye transaksjoner er ikke godkjent, så du kan gå gjennom dem i YNAB.`;
    loadRecent();
  } catch {
    status.hidden = true;
  } finally {
    updateImportButton();
  }
}

// --- File conversion ------------------------------------------------------

async function handle(file) {
  showError("");
  $("result").hidden = true;
  $("import-status").hidden = true;
  try {
    conversion = { name: file.name, ...convert(new Uint8Array(await file.arrayBuffer())) };
    render();
  } catch (e) {
    conversion = null;
    save(sessionStorage, KEYS.conversion, null);
    showError(e.message);
  }
}

// The bank's own columns are shown after the ones that are imported, muted, to
// help explain how a row was converted. Selectable tables start with a checkbox
// column for leaving rows out of the import.
function headerRow(columns, showSource, selectable = false) {
  const tr = document.createElement("tr");
  if (selectable) {
    const th = Object.assign(document.createElement("th"), { className: "include" });
    th.append(Object.assign(document.createElement("input"), { type: "checkbox", id: "include-all", title: "Ta med alle" }));
    tr.append(th);
  }
  for (const [className, name] of [["date", "Dato"], ["payee", "Mottaker"], ["memo", "Notat"], ["amount", "Beløp"]]) {
    tr.append(Object.assign(document.createElement("th"), { className, textContent: name }));
  }
  if (showSource) {
    for (const name of columns) {
      tr.append(Object.assign(document.createElement("th"), { className: "source", textContent: name }));
    }
  }
  return tr;
}

function transactionRows(transactions, columns, showSource, selectable = false) {
  return transactions.map((t, index) => {
    const tr = document.createElement("tr");
    if (selectable) {
      tr.classList.toggle("excluded", Boolean(t.excluded));
      const box = Object.assign(document.createElement("input"), {
        type: "checkbox",
        checked: !t.excluded,
        title: "Ta med i importen",
      });
      box.dataset.index = index;
      const td = Object.assign(document.createElement("td"), { className: "include" });
      td.append(box);
      tr.append(td);
    }
    const cells = [
      ["date", displayDate(t.date)],
      ["payee", t.payee],
      ["memo", t.memo],
      [`amount ${t.amount < 0 ? "neg" : "pos"}`, amountFormat.format(t.amount)],
    ];
    if (showSource) cells.push(...columns.map((name, i) => ["source", t.source[i], name]));
    for (const [cls, text, label] of cells) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      if (label) td.dataset.label = label;
      tr.append(td);
    }
    return tr;
  });
}

/** Updates what depends on which transactions are excluded from the import. */
function updateSelection() {
  const { transactions, pending, ignored } = conversion;
  const excluded = transactions.filter((t) => t.excluded).length;
  const parts = [transactionCount(transactions.length)];
  if (excluded) parts.push(`${excluded} utelatt`);
  if (pending.length) parts.push(`${pending.length} reservert, hoppet over`);
  if (ignored.length) parts.push(`${ignored.length} andre rader hoppet over`);
  $("counts").textContent = parts.join(" · ");

  const all = $("include-all");
  all.checked = excluded === 0;
  all.indeterminate = excluded > 0 && excluded < transactions.length;
  $("download").disabled = excluded === transactions.length;
  updateExcludeSeen();
  updateImportButton();
}

function render() {
  const { columns, transactions, pending, ignored } = conversion;
  const showSource = $("show-source").checked;
  save(sessionStorage, KEYS.conversion, conversion);

  $("head").replaceChildren(headerRow(columns, showSource, true));
  $("rows").replaceChildren(...transactionRows(transactions, columns, showSource, true));

  $("pending").hidden = !pending.length;
  $("pending").querySelector("summary").textContent = `${pending.length} reservert, hoppet over`;
  $("pending-head").replaceChildren(headerRow(columns, showSource));
  $("pending-rows").replaceChildren(...transactionRows(pending, columns, showSource));

  $("ignored").hidden = !ignored.length;
  $("ignored").querySelector("summary").textContent = `${ignored.length} andre rader hoppet over`;
  $("ignored-rows").replaceChildren(
    ...ignored.map((text) => Object.assign(document.createElement("li"), { textContent: text })),
  );

  $("result").hidden = false;
  updateSelection();
  loadRecent();
}

function download() {
  const csv = toYnabCsv(conversion.transactions.filter((t) => !t.excluded));
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const name = conversion.name.replace(/\.csv$/i, "") + "-ynab.csv";
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

function clear() {
  conversion = null;
  save(sessionStorage, KEYS.conversion, null);
  // Resetting the input lets the same file be chosen again.
  input.value = "";
  showError("");
  $("result").hidden = true;
  $("import-status").hidden = true;
  updateImportButton();
  loadRecent();
}

// --- Wiring ---------------------------------------------------------------

const drop = $("drop");
const input = $("file");

$("connect").addEventListener("click", connect);
$("about-open").addEventListener("click", () => $("about").showModal());
$("about-close").addEventListener("click", () => $("about").close());
// A click on the backdrop lands on the dialog itself, outside its content box.
$("about").addEventListener("click", (e) => {
  const box = e.currentTarget.getBoundingClientRect();
  const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
  if (!inside) e.currentTarget.close();
});
$("disconnect").addEventListener("click", () => disconnect());
$("plan").addEventListener("change", loadAccounts);
$("account").addEventListener("change", () => {
  save(localStorage, KEYS.account, $("account").value);
  updateImportButton();
  loadRecent();
});
$("rows").addEventListener("change", (e) => {
  const { index } = e.target.dataset;
  if (index === undefined) return;
  const transaction = conversion.transactions[index];
  transaction.excluded = !e.target.checked;
  e.target.closest("tr").classList.toggle("excluded", transaction.excluded);
  save(sessionStorage, KEYS.conversion, conversion);
  updateSelection();
});
$("head").addEventListener("change", (e) => {
  if (e.target.id !== "include-all") return;
  for (const t of conversion.transactions) t.excluded = !e.target.checked;
  render();
});
$("recent").open = Boolean(load(localStorage, KEYS.showRecent));
$("recent").addEventListener("toggle", () => save(localStorage, KEYS.showRecent, $("recent").open));
$("import").addEventListener("click", importTransactions);
$("download").addEventListener("click", download);
$("clear").addEventListener("click", clear);
$("exclude-seen").addEventListener("click", excludeSeen);
$("show-source").checked = Boolean(load(localStorage, KEYS.showSource));
$("show-source").addEventListener("change", () => {
  save(localStorage, KEYS.showSource, $("show-source").checked);
  render();
});

input.addEventListener("change", () => input.files[0] && handle(input.files[0]));
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) handle(file);
});
// Dropping a file outside the zone should not navigate away from the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

restoreSession();
renderAuth();
if (conversion) render();
