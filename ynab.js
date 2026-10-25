// YNAB API access from the browser, authorised through OAuth's implicit grant.
// The implicit grant needs no backend: YNAB redirects back with the access token
// in the URL fragment. Tokens last two hours and cannot be refreshed.

const AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize";
const API_URL = "https://api.ynab.com/v1";

/** Builds the URL that starts the OAuth flow. */
export function authorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Reads the OAuth response from a URL fragment ("#access_token=...&expires_in=...").
 * Returns null when the fragment carries no OAuth response.
 */
export function parseRedirect(hash, now = Date.now()) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (params.has("error")) {
    return { error: params.get("error_description") || params.get("error"), state: params.get("state") };
  }
  const token = params.get("access_token");
  if (!token) return null;
  const expiresIn = Number(params.get("expires_in")) || 7200;
  return { token, expiresAt: now + expiresIn * 1000, state: params.get("state") };
}

/**
 * Maps converted transactions to YNAB API transactions for one account.
 * The import_id follows the format YNAB uses for file-based and direct import
 * ("YNAB:<milliunits>:<date>:<occurrence>"), so a transaction already imported
 * by any of those routes is reported as a duplicate instead of created twice.
 */
export function toApiTransactions(transactions, accountId) {
  const occurrences = new Map();
  return transactions.map((t) => {
    const amount = Math.round(t.amount * 1000);
    const key = `${amount}:${t.date}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return {
      account_id: accountId,
      date: t.date,
      amount,
      payee_name: t.payee || null,
      memo: t.memo || null,
      cleared: "cleared",
      approved: false,
      import_id: `YNAB:${key}:${occurrence}`,
    };
  });
}

export class YnabError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

export class Ynab {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new YnabError(res.status, json?.error?.detail || `YNAB API returned ${res.status}`);
    }
    return json.data;
  }

  async plans() {
    const { plans, default_plan } = await this.request("GET", "/plans");
    return { plans, defaultPlan: default_plan };
  }

  async accounts(planId) {
    const { accounts } = await this.request("GET", `/plans/${encodeURIComponent(planId)}/accounts`);
    return accounts.filter((a) => !a.closed && !a.deleted);
  }

  /** Creates transactions; returns { created, duplicates } counts. */
  async createTransactions(planId, transactions) {
    const data = await this.request("POST", `/plans/${encodeURIComponent(planId)}/transactions`, {
      transactions,
    });
    return {
      created: data.transaction_ids.length,
      duplicates: data.duplicate_import_ids?.length ?? 0,
    };
  }
}
