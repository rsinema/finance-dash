import { db } from "./index";
import type { Category } from "../lib/categories";

export interface PlaidItemRow {
  item_id: string;
  access_token_enc: string;
  institution_id: string | null;
  institution_name: string | null;
  cursor: string | null;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AccountRow {
  id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  currency: string | null;
  created_at: number;
  updated_at: number;
}

export interface TransactionRow {
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
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MerchantRuleRow {
  merchant_key: string;
  category: Category;
  confidence: number;
  source: "llm" | "manual";
  sample_name: string | null;
  hit_count: number;
  created_at: number;
  updated_at: number;
}

export interface SyncLogRow {
  id: number;
  item_id: string;
  started_at: number;
  finished_at: number | null;
  added: number;
  modified: number;
  removed: number;
  error: string | null;
}

// ---------- Items ----------

export function upsertItem(input: {
  item_id: string;
  access_token_enc: string;
  institution_id: string | null;
  institution_name: string | null;
}): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO plaid_items (item_id, access_token_enc, institution_id, institution_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         institution_id = excluded.institution_id,
         institution_name = excluded.institution_name,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.item_id,
      input.access_token_enc,
      input.institution_id,
      input.institution_name,
      now,
      now,
    );
}

export function listItems(): PlaidItemRow[] {
  return db()
    .query<PlaidItemRow, []>("SELECT * FROM plaid_items ORDER BY created_at ASC")
    .all();
}

export function getItem(itemId: string): PlaidItemRow | null {
  return db()
    .query<PlaidItemRow, [string]>("SELECT * FROM plaid_items WHERE item_id = ?")
    .get(itemId);
}

export function updateItemCursor(itemId: string, cursor: string): void {
  db()
    .prepare(
      "UPDATE plaid_items SET cursor = ?, last_synced_at = ?, updated_at = ? WHERE item_id = ?",
    )
    .run(cursor, Date.now(), Date.now(), itemId);
}

export function deleteItem(itemId: string): void {
  db().prepare("DELETE FROM plaid_items WHERE item_id = ?").run(itemId);
}

// ---------- Accounts ----------

export function upsertAccount(input: {
  id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  currency: string | null;
}): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO accounts (id, item_id, name, official_name, type, subtype, mask, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         item_id = excluded.item_id,
         name = excluded.name,
         official_name = excluded.official_name,
         type = excluded.type,
         subtype = excluded.subtype,
         mask = excluded.mask,
         currency = excluded.currency,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.item_id,
      input.name,
      input.official_name,
      input.type,
      input.subtype,
      input.mask,
      input.currency,
      now,
      now,
    );
}

export function listAccounts(itemId?: string): AccountRow[] {
  if (itemId) {
    return db()
      .query<AccountRow, [string]>("SELECT * FROM accounts WHERE item_id = ? ORDER BY name")
      .all(itemId);
  }
  return db().query<AccountRow, []>("SELECT * FROM accounts ORDER BY name").all();
}

// ---------- Transactions ----------

export interface UpsertTransactionInput {
  id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  plaid_category: string | null;
}

// Insert-or-update preserving classification fields when the merchant/amount don't change.
// Returns: 'inserted' | 'updated' | 'unchanged'.
export type UpsertOutcome = "inserted" | "updated" | "unchanged";

export function upsertTransaction(input: UpsertTransactionInput): UpsertOutcome {
  const now = Date.now();
  const existing = db()
    .query<TransactionRow, [string]>("SELECT * FROM transactions WHERE id = ?")
    .get(input.id);

  if (!existing) {
    db()
      .prepare(
        `INSERT INTO transactions (
          id, account_id, amount, iso_currency_code, date, authorized_date,
          name, merchant_name, pending, plaid_category,
          category, confidence, classification_source, needs_review,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        input.id,
        input.account_id,
        input.amount,
        input.iso_currency_code,
        input.date,
        input.authorized_date,
        input.name,
        input.merchant_name,
        input.pending ? 1 : 0,
        input.plaid_category,
        now,
        now,
      );
    return "inserted";
  }

  const merchantChanged =
    existing.merchant_name !== input.merchant_name || existing.name !== input.name;
  const amountChanged = existing.amount !== input.amount;
  const materialChange = merchantChanged || amountChanged;

  db()
    .prepare(
      `UPDATE transactions SET
         account_id = ?, amount = ?, iso_currency_code = ?, date = ?, authorized_date = ?,
         name = ?, merchant_name = ?, pending = ?, plaid_category = ?,
         updated_at = ?,
         deleted_at = NULL
       WHERE id = ?`,
    )
    .run(
      input.account_id,
      input.amount,
      input.iso_currency_code,
      input.date,
      input.authorized_date,
      input.name,
      input.merchant_name,
      input.pending ? 1 : 0,
      input.plaid_category,
      now,
      input.id,
    );

  return materialChange ? "updated" : "unchanged";
}

export function softDeleteTransaction(id: string): void {
  const now = Date.now();
  db()
    .prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

export function getTransaction(id: string): TransactionRow | null {
  return db()
    .query<TransactionRow, [string]>("SELECT * FROM transactions WHERE id = ?")
    .get(id);
}

export function setTransactionClassification(input: {
  id: string;
  category: Category;
  confidence: number;
  source: "rule" | "llm" | "manual";
  needs_review: boolean;
  reviewed_at?: number | null;
}): void {
  const now = Date.now();
  db()
    .prepare(
      `UPDATE transactions SET
         category = ?, confidence = ?, classification_source = ?,
         needs_review = ?, reviewed_at = COALESCE(?, reviewed_at),
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.category,
      input.confidence,
      input.source,
      input.needs_review ? 1 : 0,
      input.reviewed_at ?? null,
      now,
      input.id,
    );
}

export function clearNeedsReview(id: string): void {
  const now = Date.now();
  db()
    .prepare(
      "UPDATE transactions SET needs_review = 0, reviewed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, now, id);
}

export interface TxQueryParams {
  from?: string;
  to?: string;
  category?: string;
  account?: string;
  search?: string;
  review?: boolean;
  limit?: number;
  offset?: number;
}

export function queryTransactions(params: TxQueryParams): { rows: TransactionRow[]; total: number } {
  const where: string[] = ["deleted_at IS NULL"];
  const args: (string | number)[] = [];
  if (params.from) {
    where.push("date >= ?");
    args.push(params.from);
  }
  if (params.to) {
    where.push("date <= ?");
    args.push(params.to);
  }
  if (params.category) {
    where.push("category = ?");
    args.push(params.category);
  }
  if (params.account) {
    where.push("account_id = ?");
    args.push(params.account);
  }
  if (params.search) {
    where.push("(LOWER(name) LIKE ? OR LOWER(merchant_name) LIKE ?)");
    const term = `%${params.search.toLowerCase()}%`;
    args.push(term, term);
  }
  if (params.review) {
    where.push("needs_review = 1");
  }
  const whereClause = `WHERE ${where.join(" AND ")}`;

  const totalRow = db()
    .query<{ c: number }, (string | number)[]>(
      `SELECT COUNT(*) as c FROM transactions ${whereClause}`,
    )
    .get(...args);
  const total = totalRow?.c ?? 0;

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const offset = Math.max(params.offset ?? 0, 0);
  const rows = db()
    .query<TransactionRow, (string | number)[]>(
      `SELECT * FROM transactions ${whereClause} ORDER BY date DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(...args);
  return { rows, total };
}

export function listUnclassifiedTransactions(limit = 1000): TransactionRow[] {
  // Treat both genuinely unclassified rows and our zero-confidence fallback rows as "needs work".
  // The fallback path uses confidence=0 + classification_source='llm' as a sentinel.
  return db()
    .query<TransactionRow, [number]>(
      `SELECT * FROM transactions
       WHERE deleted_at IS NULL
       AND (category IS NULL OR (confidence = 0 AND classification_source = 'llm'))
       ORDER BY date DESC LIMIT ?`,
    )
    .all(limit);
}

// ---------- Merchant rules ----------

export function getRule(merchantKey: string): MerchantRuleRow | null {
  return db()
    .query<MerchantRuleRow, [string]>("SELECT * FROM merchant_rules WHERE merchant_key = ?")
    .get(merchantKey);
}

export function bumpRuleHit(merchantKey: string): void {
  db()
    .prepare(
      "UPDATE merchant_rules SET hit_count = hit_count + 1, updated_at = ? WHERE merchant_key = ?",
    )
    .run(Date.now(), merchantKey);
}

export function upsertRule(input: {
  merchant_key: string;
  category: Category;
  confidence: number;
  source: "llm" | "manual";
  sample_name: string | null;
}): void {
  const now = Date.now();
  // Manual rules override anything; LLM rules don't override manual rules.
  db()
    .prepare(
      `INSERT INTO merchant_rules (merchant_key, category, confidence, source, sample_name, hit_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(merchant_key) DO UPDATE SET
         category = CASE
           WHEN excluded.source = 'manual' THEN excluded.category
           WHEN merchant_rules.source = 'manual' THEN merchant_rules.category
           ELSE excluded.category
         END,
         confidence = CASE
           WHEN excluded.source = 'manual' THEN excluded.confidence
           WHEN merchant_rules.source = 'manual' THEN merchant_rules.confidence
           ELSE excluded.confidence
         END,
         source = CASE
           WHEN excluded.source = 'manual' THEN 'manual'
           WHEN merchant_rules.source = 'manual' THEN 'manual'
           ELSE 'llm'
         END,
         sample_name = COALESCE(merchant_rules.sample_name, excluded.sample_name),
         updated_at = excluded.updated_at`,
    )
    .run(
      input.merchant_key,
      input.category,
      input.confidence,
      input.source,
      input.sample_name,
      now,
      now,
    );
}

export function listRules(): MerchantRuleRow[] {
  return db()
    .query<MerchantRuleRow, []>(
      "SELECT * FROM merchant_rules ORDER BY hit_count DESC, merchant_key",
    )
    .all();
}

export function deleteRule(merchantKey: string): void {
  db().prepare("DELETE FROM merchant_rules WHERE merchant_key = ?").run(merchantKey);
}

// ---------- Sync log ----------

export function startSyncLog(itemId: string): number {
  const result = db()
    .prepare("INSERT INTO sync_log (item_id, started_at) VALUES (?, ?)")
    .run(itemId, Date.now());
  return Number(result.lastInsertRowid);
}

export function finishSyncLog(input: {
  id: number;
  added: number;
  modified: number;
  removed: number;
  error?: string | null;
}): void {
  db()
    .prepare(
      "UPDATE sync_log SET finished_at = ?, added = ?, modified = ?, removed = ?, error = ? WHERE id = ?",
    )
    .run(
      Date.now(),
      input.added,
      input.modified,
      input.removed,
      input.error ?? null,
      input.id,
    );
}

export function lastSyncByItem(): Array<SyncLogRow & { institution_name: string | null }> {
  return db()
    .query<SyncLogRow & { institution_name: string | null }, []>(
      `SELECT s.*, i.institution_name
       FROM sync_log s
       LEFT JOIN plaid_items i ON i.item_id = s.item_id
       WHERE s.id IN (SELECT MAX(id) FROM sync_log GROUP BY item_id)
       ORDER BY s.started_at DESC`,
    )
    .all();
}
