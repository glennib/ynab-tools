# handynab

A static web app that imports a Handelsbanken transaction export (CSV) into YNAB.
Everything runs in the browser: the file is parsed locally and sent only to the YNAB API, and there is no backend.

1. Connect YNAB (OAuth). The access token is kept in the tab's session storage and expires after two hours.
2. Choose or drop the Handelsbanken export and check the preview.
3. Pick a plan and account and import. Transactions arrive cleared and unapproved, ready for review in YNAB.

Without connecting, the converted file can be downloaded as a CSV for
[YNAB's file-based import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo.md) instead.

## Conversion

- The date is the booking date (`Bokført dato`).
- Pending rows (`Reservert`) are skipped; they are imported once booked.
- Payee is the counterparty name when the bank provides one, otherwise a cleaned-up `Beskrivelse`.
- Memo is `Melding/KID/Fakt.nr`, with line breaks joined by ` / `.
- Imported transactions get an `import_id` in the format YNAB itself uses for file-based and direct import
  (`YNAB:<milliunits>:<date>:<occurrence>`).
  Importing the same transaction twice, by any of those routes, is reported as a duplicate rather than creating it again.
  This relies on the booking date and amount staying stable between exports.
- The downloaded CSV has the columns `Date,Payee,Memo,Amount`, with ISO dates and a single signed amount.
  In YNAB's import dialog, map `Amount` to both Inflow and Outflow.

## YNAB OAuth application

The app uses OAuth's implicit grant, so it needs an OAuth application registered under
[YNAB developer settings](https://app.ynab.com/settings/developer), but no client secret.
List every URL the app is served from (including `http://localhost:3000/` for development) as a redirect URI.
For development, put the client ID in `config.js`; the container image takes it from an environment variable.

## Container image

CI tests every push and pull request and builds the image for `linux/amd64` and `linux/arm64`.
Pushes to `main` publish `ghcr.io/glennib/handynab:latest` and `:sha-<commit>`, and `v*` tags publish
`:<version>` and `:<major>.<minor>`.

The image is nginx running as a non-root user on port 8080:

- `YNAB_CLIENT_ID` sets the OAuth client ID, served to the page as `/config.js`.
- `/healthz` answers `ok`, for liveness and readiness probes.
- Responses carry a Content-Security-Policy that only allows the page's own scripts and requests to the YNAB API.

```sh
podman build -t handynab .
podman run --rm -p 8080:8080 -e YNAB_CLIENT_ID=<client id> handynab
```

## Development

Tools are managed with [mise](https://mise.jdx.dev/).

```sh
mise run test   # unit tests
mise run serve  # serve locally; ES modules don't load over file://
```
