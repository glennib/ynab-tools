# handynab

A static web page that converts a Handelsbanken transaction export (CSV) into a CSV for
[YNAB's file-based import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo.md).
Everything runs in the browser; the file never leaves your machine.

Drop the export on the page, check the preview, and download the converted file.

## Conversion

- Output columns are `Date,Payee,Memo,Amount`, with ISO dates and a single signed amount.
  In YNAB's import dialog, map `Amount` to both Inflow and Outflow.
- The date is the booking date (`Bokført dato`).
  YNAB detects duplicates by date and amount, so it must stay stable between exports.
- Pending rows (`Reservert`) are skipped; they are imported once booked.
- Payee is the counterparty name when the bank provides one, otherwise a cleaned-up `Beskrivelse`.
- Memo is `Melding/KID/Fakt.nr`, with line breaks joined by ` / `.

## Development

Tools are managed with [mise](https://mise.jdx.dev/).

```sh
mise run test   # unit tests
mise run serve  # serve locally; ES modules don't load over file://
```
