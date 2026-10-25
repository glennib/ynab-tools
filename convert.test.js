import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, toYnabCsv } from "./convert.js";

const HEADER =
  "Utført dato;Bokført dato;Rentedato;Beskrivelse;Type;Undertype;Fra konto;Avsender;Til konto;Mottakernavn;Beløp inn;Beløp ut;Valuta;Status;Melding/KID/Fakt.nr";

const SAMPLE = [
  "﻿" + HEADER,
  "24.10.2026;;;KIWI 100 SENTRUM;Varekjøp;;1234 56 78901;Felleskonto;;;;-100.500;NOK;Reservert;KIWI 100 SENTRUM",
  "23.10.2026;23.10.2026;23.10.2026;Vipps*KAFE;Varekjøp;Varekjøp debetkort;1234 56 78901;Ola Nordmann;;;;-33;NOK;Bokført;*1111 22.10 NOK 33.00 Vipps*KAFE Kurs: 1.0000",
  "23.10.2026;23.10.2026;23.10.2026;22.10 KIWI 100 SENTRUM STORGATA OSLO;Varekjøp;Varekjøp debetkort;1234 56 78901;Ola Nordmann;;;;-79.8;NOK;Bokført;22.10 KIWI 100 SENTRUM STORGATA OSLO",
  "23.10.2026;23.10.2026;23.10.2026;Lønn fra EKSEMPEL AS;Lønn;Lønn;1111 22 33333;;1234 56 78901;Ola Nordmann;50000.17;;NOK;Bokført;Fra: EKSEMPEL AS",
  "20.10.2026;20.10.2026;20.10.2026;OSLO KOMMUNE (12345678901);Betaling innland - eFaktura;Betaling med KID innland;1234 56 78901;Ola Nordmann;1234 56 78901;OSLO KOMMUNE;;-2940;NOK;Bokført;Til: OSLO KOMMUNE Betalt: 20.10.26",
  '16.10.2026;16.10.2026;16.10.2026;STRØM AS;Betaling innland;Overføring fra annen konto;2222 33 44444;STRØM AS;1234 56 78901;Ola Nordmann;713.66;;NOK;Bokført;"Fra: STRØM AS Betalt: 16.10.26',
  "Kundenummer: 123               Faktureringsavtaleid: 456",
  'Fakturanr: 789"',
  ";;;;;;;;;;;;;;",
  "Total beløp inn på konto:;;50 713,83 NOK;;;;;;;;;;;;",
  ";;;;;;;;;;;;;;",
  "Utgående  saldo pr. 25.10.2026:;;1 234,56 NOK;;;;;;;;;;;;",
  "",
].join("\n");

const bytes = (s) => new TextEncoder().encode(s);

test("converts booked transactions and skips pending and summary rows", () => {
  const { columns, transactions: converted, pending: pendingRows, ignored } = convert(bytes(SAMPLE));
  const withoutSource = (rows) => rows.map(({ source, ...t }) => t);
  const transactions = withoutSource(converted);
  const pending = withoutSource(pendingRows);
  assert.equal(columns.length, 15);
  assert.equal(converted[0].source[columns.indexOf("Status")], "Bokført");
  assert.deepEqual(pending, [
    { date: "2026-10-24", payee: "KIWI 100 SENTRUM", memo: "KIWI 100 SENTRUM", amount: -100.5 },
  ]);
  assert.deepEqual(ignored, [
    "Total beløp inn på konto: · 50 713,83 NOK",
    "Utgående  saldo pr. 25.10.2026: · 1 234,56 NOK",
  ]);
  assert.deepEqual(transactions, [
    { date: "2026-10-23", payee: "KAFE", memo: "*1111 22.10 NOK 33.00 Vipps*KAFE Kurs: 1.0000", amount: -33 },
    { date: "2026-10-23", payee: "KIWI 100 SENTRUM STORGATA OSLO", memo: "22.10 KIWI 100 SENTRUM STORGATA OSLO", amount: -79.8 },
    { date: "2026-10-23", payee: "EKSEMPEL AS", memo: "Fra: EKSEMPEL AS", amount: 50000.17 },
    { date: "2026-10-20", payee: "OSLO KOMMUNE", memo: "Til: OSLO KOMMUNE Betalt: 20.10.26", amount: -2940 },
    {
      date: "2026-10-16",
      payee: "STRØM AS",
      memo: "Fra: STRØM AS Betalt: 16.10.26 / Kundenummer: 123 Faktureringsavtaleid: 456 / Fakturanr: 789",
      amount: 713.66,
    },
  ]);
});

test("falls back to Windows-1252 when the file is not UTF-8", () => {
  const latin1 = Uint8Array.from(SAMPLE.replace("﻿", ""), (c) => c.charCodeAt(0));
  const { transactions } = convert(latin1);
  assert.equal(transactions.at(-1).payee, "STRØM AS");
});

test("rejects files without the expected columns", () => {
  assert.throws(() => convert(bytes("Date;Amount\n01.01.2026;1\n")), /Fant ikke kolonnen/);
});

test("serialises YNAB CSV with quoting", () => {
  const csv = toYnabCsv([{ date: "2026-10-23", payee: 'A, "B"', memo: "", amount: -1.5 }]);
  assert.equal(csv, 'Date,Payee,Memo,Amount\n2026-10-23,"A, ""B""",,-1.50\n');
});
