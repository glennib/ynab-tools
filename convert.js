// Converts a Handelsbanken transaction export (semicolon-separated CSV) into a
// CSV that YNAB's file-based import maps directly: Date, Payee, Memo, Amount.

const MEMO_MAX = 500;
const PAYEE_MAX = 200;

const COLUMNS = {
  executed: "Utført dato",
  booked: "Bokført dato",
  description: "Beskrivelse",
  sender: "Avsender",
  recipient: "Mottakernavn",
  inflow: "Beløp inn",
  outflow: "Beløp ut",
  status: "Status",
  message: "Melding/KID/Fakt.nr",
};

/** Decodes file bytes as UTF-8 (BOM stripped), falling back to Windows-1252. */
export function decode(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

/** Parses delimited text into rows, honouring quoted fields that span lines. */
export function parseCsv(text, delimiter = ";") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "23.10.2026" -> "2026-10-23", or null if the value is not such a date. */
function isoDate(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Parses amounts like "-1055.250", "56391.17" or "1 234,50"; null if empty. */
function parseAmount(value) {
  const cleaned = value.replace(/[\s ]/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanPayee(description) {
  return description
    .replace(/^\d{2}\.\d{2}\s+/, "") // "22.10 KIWI ..." (purchase date prefix)
    .replace(/^Lønn fra\s+/i, "")
    .replace(/^(Vipps|PayPal_?)\*\s*/i, "")
    .replace(/\s*\(\d{11}\)$/, "") // "VIKEN FIBER AS (60050623826)" (account number)
    .trim();
}

function squash(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
}

/**
 * Converts parsed Handelsbanken rows to YNAB transactions.
 * Pending ("Reservert") rows are left out since they reappear once booked, and
 * would otherwise be imported twice; they are returned separately, dated by when
 * they were made. Rows without a booked date (summary lines) are returned as
 * their non-empty cells, and blank padding rows are dropped.
 * Transactions keep the bank's own cells as `source`, matching `columns`, so
 * the preview can show what each one was converted from.
 */
export function convertRows(rows) {
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const idx = {};
  for (const [key, name] of Object.entries(COLUMNS)) {
    idx[key] = header.indexOf(name);
    if (idx[key] === -1) {
      throw new Error(`Fant ikke kolonnen "${name}". Er dette en eksport fra Handelsbanken?`);
    }
  }

  const transactions = [];
  const pending = [];
  const ignored = [];
  for (const row of rows.slice(1)) {
    const get = (key) => (row[idx[key]] ?? "").trim();
    const transaction = (date, amount) => {
      const counterparty = amount >= 0 ? get("sender") : get("recipient");
      const payee = (counterparty || cleanPayee(get("description"))).slice(0, PAYEE_MAX);
      const memo = squash(row[idx.message] ?? "").slice(0, MEMO_MAX);
      const source = header.map((_, i) => squash(row[i] ?? ""));
      return { date, payee, memo, amount, source };
    };
    const amount = parseAmount(get("inflow")) ?? parseAmount(get("outflow"));
    if (get("status") === "Reservert") {
      pending.push(transaction(isoDate(get("executed")) ?? "", amount ?? 0));
      continue;
    }
    const date = isoDate(get("booked"));
    if (!date || amount === null) {
      const cells = row.map((cell) => cell.trim()).filter(Boolean);
      if (cells.length) ignored.push(cells.join(" · "));
      continue;
    }
    transactions.push(transaction(date, amount));
  }
  return { columns: header, transactions, pending, ignored };
}

function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialises transactions as a comma-separated YNAB import CSV. */
export function toYnabCsv(transactions) {
  const lines = [["Date", "Payee", "Memo", "Amount"]];
  for (const t of transactions) {
    lines.push([t.date, t.payee, t.memo, t.amount.toFixed(2)]);
  }
  return lines.map((cols) => cols.map(csvField).join(",")).join("\n") + "\n";
}

export function convert(bytes) {
  return convertRows(parseCsv(decode(bytes)));
}
