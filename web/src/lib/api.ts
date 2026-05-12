import type { Category } from "./categories";

export interface Transaction {
  id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: number;
  plaid_category: string | null;
  category: Category | null;
  confidence: number | null;
  classification_source: "rule" | "llm" | "manual" | null;
  needs_review: number;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyncStatus {
  id: number;
  item_id: string;
  started_at: number;
  finished_at: number | null;
  added: number;
  modified: number;
  removed: number;
  error: string | null;
  institution_name: string | null;
}

export interface PlaidItemDescriptor {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  cursor: string | null;
  last_synced_at: number | null;
  created_at: number;
}

export interface SummaryByCategory {
  groupBy: "category";
  from: string | null;
  to: string | null;
  buckets: Array<{ category: string; total: number; count: number }>;
  spending_total: number;
  income_total: number;
}

export interface SummaryByMonth {
  groupBy: "month";
  from: string | null;
  to: string | null;
  buckets: Array<{ month: string; total: number; count: number }>;
}

export interface MerchantRule {
  merchant_key: string;
  category: Category;
  confidence: number;
  source: "llm" | "manual";
  sample_name: string | null;
  hit_count: number;
  created_at: number;
  updated_at: number;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!resp.ok) {
    let message = resp.statusText;
    try {
      const body = (await resp.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, message);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; db: boolean }>("/health"),
  version: () => request<{ version: string }>("/version"),

  // Plaid
  plaidStatus: () => request<{ configured: boolean; env: string }>("/plaid/status"),
  createLinkToken: (itemId?: string) =>
    request<{ link_token: string }>("/plaid/link-token", {
      method: "POST",
      body: JSON.stringify(itemId ? { itemId } : {}),
    }),
  exchangePublicToken: (public_token: string) =>
    request<{ item_id: string; institution_name: string | null }>("/plaid/exchange", {
      method: "POST",
      body: JSON.stringify({ public_token }),
    }),
  listItems: () => request<{ items: PlaidItemDescriptor[] }>("/plaid/items"),
  removeItem: (itemId: string) =>
    request<{ ok: boolean }>(`/plaid/items/${encodeURIComponent(itemId)}`, { method: "DELETE" }),

  // Sync
  sync: (itemId?: string) =>
    request<{ results: Array<{ itemId: string; added: number; modified: number; removed: number; classified: number; error?: string }> }>(
      itemId ? `/sync?itemId=${encodeURIComponent(itemId)}` : "/sync",
      { method: "POST" },
    ),
  syncStatus: () => request<{ items: SyncStatus[] }>("/sync/status"),
  reclassifyFailed: () =>
    request<{ classified: number; failed: number }>("/sync/reclassify-failed", { method: "POST" }),

  // Transactions
  listTransactions: (params: {
    from?: string;
    to?: string;
    category?: string;
    account?: string;
    search?: string;
    review?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    return request<{ transactions: Transaction[]; total: number; limit: number; offset: number }>(
      `/transactions?${qs.toString()}`,
    );
  },
  getTransaction: (id: string) => request<Transaction>(`/transactions/${id}`),
  patchTransaction: (id: string, category: Category) =>
    request<{ ok: boolean }>(`/transactions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ category }),
    }),
  acceptTransaction: (id: string) =>
    request<{ ok: boolean }>(`/transactions/${id}/accept`, { method: "POST" }),
  reclassifyTransaction: (id: string) =>
    request<{ ok: boolean }>(`/transactions/${id}/reclassify`, { method: "POST" }),

  // Summaries
  summaryByCategory: (from?: string, to?: string) => {
    const qs = new URLSearchParams({ groupBy: "category" });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return request<SummaryByCategory>(`/summary?${qs.toString()}`);
  },
  summaryByMonth: (from?: string, to?: string) => {
    const qs = new URLSearchParams({ groupBy: "month" });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return request<SummaryByMonth>(`/summary?${qs.toString()}`);
  },

  // Rules
  listRules: () => request<{ rules: MerchantRule[] }>("/rules"),
  patchRule: (key: string, category: Category) =>
    request<{ ok: boolean }>(`/rules/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({ category }),
    }),
  deleteRule: (key: string) =>
    request<{ ok: boolean }>(`/rules/${encodeURIComponent(key)}`, { method: "DELETE" }),

  // Backups
  listBackups: () =>
    request<{
      local: Array<{ name: string; bytes: number; mtime: number }>;
      s3: {
        enabled: boolean;
        bucket: string;
        prefix: string;
        backups: Array<{ key: string; filename: string; bytes: number; lastModified: number | null }>;
        error?: string;
      };
    }>("/backups"),
  createBackup: () =>
    request<{
      path: string;
      bytes: number;
      pruned: number;
      s3?: { key: string; bytes: number; pruned: number; error?: string };
    }>("/backups", { method: "POST" }),
  createS3Backup: () =>
    request<{ key: string; bytes: number; pruned: number }>("/backups/s3", { method: "POST" }),

  // Agent (streaming) — returns ReadableStream of newline-delimited JSON events.
  askAgent: async (question: string): Promise<Response> =>
    fetch(`/api/agent/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    }),
};

export { ApiError };
