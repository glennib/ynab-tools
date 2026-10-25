import { convert, toYnabCsv } from "./convert.js";
import { YNAB_CLIENT_ID } from "./config.js";
import { Ynab, authorizeUrl, parseRedirect, toApiTransactions } from "./ynab.js";

const $ = (id) => document.getElementById(id);

const amountFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// The token, and the last used plan and account, are kept in localStorage so they
// survive closing the tab; the token is dropped once it expires. The OAuth state and
// the converted file only need to survive the redirect, so they live in sessionStorage.
const KEYS = {
  token: "handynab.token",
  state: "handynab.oauthState",
  conversion: "handynab.conversion",
  plan: "handynab.plan",
  account: "handynab.account",
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

let conversion = null; // { name, transactions, pending, ignored }
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
    showError("No YNAB client ID is configured for this site.");
    return;
  }
  const state = crypto.randomUUID();
  save(sessionStorage, KEYS.state, state);
  // The redirect leaves the page; keep the converted file so it survives the round trip.
  save(sessionStorage, KEYS.conversion, conversion);
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
      showError("The YNAB authorisation response did not match this session. Try connecting again.");
    } else if (redirect.error) {
      showError(`YNAB authorisation failed: ${redirect.error}`);
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
  save(sessionStorage, KEYS.conversion, null);
}

function renderAuth() {
  $("connect").hidden = Boolean(ynab);
  $("disconnect").hidden = !ynab;
  if (ynab) {
    const until = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("auth-status").textContent = `Connected to YNAB until ${until}`;
  } else {
    $("auth-status").textContent = "Not connected to YNAB";
  }
  $("target").hidden = !ynab;
  if (ynab) loadPlans();
  updateImportButton();
}

/** Runs a YNAB call, dropping the session when the token is no longer accepted. */
async function call(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 401) disconnect("The YNAB session has expired. Connect again to continue.");
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
}

function updateImportButton() {
  const button = $("import");
  const count = conversion?.transactions.length ?? 0;
  const account = $("account").selectedOptions[0];
  button.disabled = !ynab || !count || !account;
  button.textContent = account
    ? `Import ${count} transactions into ${account.textContent}`
    : "Import";
}

async function importTransactions() {
  const planId = $("plan").value;
  const accountId = $("account").value;
  const status = $("import-status");
  save(localStorage, KEYS.account, accountId);
  showError("");
  $("import").disabled = true;
  status.hidden = false;
  status.textContent = "Importing…";
  try {
    const transactions = toApiTransactions(conversion.transactions, accountId);
    const { created, duplicates } = await call(() => ynab.createTransactions(planId, transactions));
    const parts = [`${created} imported`];
    if (duplicates) parts.push(`${duplicates} already in YNAB`);
    status.textContent = `${parts.join(" · ")}. New transactions are unapproved for review in YNAB.`;
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
    const { transactions, pending, ignored } = convert(new Uint8Array(await file.arrayBuffer()));
    conversion = { name: file.name, transactions, pending, ignored };
    render();
  } catch (e) {
    conversion = null;
    showError(e.message);
  }
}

function render() {
  const { transactions, pending, ignored } = conversion;
  const parts = [`${transactions.length} transactions`];
  if (pending) parts.push(`${pending} pending skipped`);
  if (ignored) parts.push(`${ignored} other rows skipped`);
  $("counts").textContent = parts.join(" · ");

  $("rows").replaceChildren(
    ...transactions.map((t) => {
      const tr = document.createElement("tr");
      const cells = [
        ["date", t.date],
        ["", t.payee],
        ["memo", t.memo],
        [`amount ${t.amount < 0 ? "neg" : "pos"}`, amountFormat.format(t.amount)],
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  $("result").hidden = false;
  updateImportButton();
}

function download() {
  const csv = toYnabCsv(conversion.transactions);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const name = conversion.name.replace(/\.csv$/i, "") + "-ynab.csv";
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

// --- Wiring ---------------------------------------------------------------

const drop = $("drop");
const input = $("file");

$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", () => disconnect());
$("plan").addEventListener("change", loadAccounts);
$("account").addEventListener("change", () => {
  save(localStorage, KEYS.account, $("account").value);
  updateImportButton();
});
$("import").addEventListener("click", importTransactions);
$("download").addEventListener("click", download);

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
