import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, parseRedirect, toApiTransactions } from "./ynab.js";

test("builds an implicit grant authorize URL", () => {
  const url = new URL(authorizeUrl({ clientId: "abc", redirectUri: "https://x.test/app/", state: "s1" }));
  assert.equal(url.origin + url.pathname, "https://app.ynab.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x.test/app/");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("state"), "s1");
});

test("parses the token from the redirect fragment", () => {
  assert.deepEqual(parseRedirect("#access_token=tok&token_type=bearer&expires_in=7200&state=s1", 1000), {
    token: "tok",
    expiresAt: 1000 + 7200 * 1000,
    state: "s1",
  });
  assert.deepEqual(parseRedirect("#error=access_denied&state=s1"), { error: "access_denied", state: "s1" });
  assert.equal(parseRedirect(""), null);
});

test("maps transactions to milliunits with YNAB-style import ids", () => {
  const txs = toApiTransactions(
    [
      { date: "2026-10-23", payee: "KIWI", memo: "", amount: -79.8 },
      { date: "2026-10-23", payee: "KIWI", memo: "x", amount: -79.8 },
      { date: "2026-10-23", payee: "", memo: "", amount: 0.1 + 0.2 },
    ],
    "acc",
  );
  assert.deepEqual(
    txs.map((t) => [t.amount, t.import_id, t.payee_name, t.memo]),
    [
      [-79800, "YNAB:-79800:2026-10-23:1", "KIWI", null],
      [-79800, "YNAB:-79800:2026-10-23:2", "KIWI", "x"],
      [300, "YNAB:300:2026-10-23:1", null, null],
    ],
  );
  assert.ok(txs.every((t) => t.account_id === "acc" && t.cleared === "cleared" && t.approved === false));
  assert.ok(txs.every((t) => t.import_id.length <= 36));
});
