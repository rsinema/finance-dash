import {
  finishSyncLog,
  getItem,
  listItems,
  setTransactionClassification,
  softDeleteTransaction,
  startSyncLog,
  upsertAccount,
  upsertTransaction,
  updateItemCursor,
  type PlaidItemRow,
  type UpsertOutcome,
} from "../db/queries";
import { decryptSecret } from "../lib/crypto";
import { plaid } from "./plaid";
import { classifyTransaction } from "./classifier";

export interface ItemSyncResult {
  itemId: string;
  added: number;
  modified: number;
  removed: number;
  classified: number;
  error?: string;
}

interface SyncStats {
  added: number;
  modified: number;
  removed: number;
  classified: number;
}

async function syncOneItem(item: PlaidItemRow): Promise<ItemSyncResult> {
  const logId = startSyncLog(item.item_id);
  const stats: SyncStats = { added: 0, modified: 0, removed: 0, classified: 0 };

  try {
    const accessToken = await decryptSecret(item.access_token_enc);

    // Refresh accounts each sync — cheap and keeps names/masks current.
    const accountsResp = await plaid().accountsGet({ access_token: accessToken });
    for (const acct of accountsResp.data.accounts) {
      upsertAccount({
        id: acct.account_id,
        item_id: item.item_id,
        name: acct.name,
        official_name: acct.official_name ?? null,
        type: acct.type ?? null,
        subtype: acct.subtype ?? null,
        mask: acct.mask ?? null,
        currency: acct.balances?.iso_currency_code ?? null,
      });
    }

    let cursor: string | undefined = item.cursor ?? undefined;
    let hasMore = true;
    const txnsToClassify: { id: string; reclassify: boolean }[] = [];

    while (hasMore) {
      const resp = await plaid().transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });
      const data = resp.data;

      // Added
      for (const t of data.added) {
        const outcome: UpsertOutcome = upsertTransaction({
          id: t.transaction_id,
          account_id: t.account_id,
          amount: t.amount,
          iso_currency_code: t.iso_currency_code ?? null,
          date: t.date,
          authorized_date: t.authorized_date ?? null,
          name: t.name,
          merchant_name: t.merchant_name ?? null,
          pending: Boolean(t.pending),
          plaid_category: t.personal_finance_category
            ? JSON.stringify(t.personal_finance_category)
            : t.category
              ? JSON.stringify(t.category)
              : null,
        });
        if (outcome === "inserted") stats.added += 1;
        else if (outcome === "updated") stats.modified += 1;
        txnsToClassify.push({ id: t.transaction_id, reclassify: false });
      }

      // Modified — Plaid reports updates to existing tx.
      for (const t of data.modified) {
        const outcome = upsertTransaction({
          id: t.transaction_id,
          account_id: t.account_id,
          amount: t.amount,
          iso_currency_code: t.iso_currency_code ?? null,
          date: t.date,
          authorized_date: t.authorized_date ?? null,
          name: t.name,
          merchant_name: t.merchant_name ?? null,
          pending: Boolean(t.pending),
          plaid_category: t.personal_finance_category
            ? JSON.stringify(t.personal_finance_category)
            : t.category
              ? JSON.stringify(t.category)
              : null,
        });
        if (outcome === "updated") {
          stats.modified += 1;
          // Material change — re-classify (treat as known so we don't force review on every edit).
          txnsToClassify.push({ id: t.transaction_id, reclassify: true });
        }
      }

      // Removed
      for (const r of data.removed) {
        if (r.transaction_id) {
          softDeleteTransaction(r.transaction_id);
          stats.removed += 1;
        }
      }

      cursor = data.next_cursor;
      hasMore = data.has_more;
      if (cursor) {
        updateItemCursor(item.item_id, cursor);
      }
    }

    // Classify any txns that need it. We do this AFTER persisting so DB state is consistent
    // even if classification fails partway through.
    const seenIds = new Set<string>();
    for (const work of txnsToClassify) {
      if (seenIds.has(work.id)) continue;
      seenIds.add(work.id);
      try {
        await classifyAndPersist(work.id, work.reclassify);
        stats.classified += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[sync] classify failed for tx ${work.id}:`, (err as Error).message);
      }
    }

    finishSyncLog({ id: logId, ...stats });
    return { itemId: item.item_id, ...stats };
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    finishSyncLog({ id: logId, ...stats, error: msg });
    // eslint-disable-next-line no-console
    console.error(`[sync] item ${item.item_id} failed:`, msg);
    return { itemId: item.item_id, ...stats, error: msg };
  }
}

async function classifyAndPersist(transactionId: string, treatAsKnown: boolean): Promise<void> {
  const { getTransaction } = await import("../db/queries");
  const tx = getTransaction(transactionId);
  if (!tx) return;
  const classification = await classifyTransaction(tx, { treatAsKnown });
  setTransactionClassification({
    id: tx.id,
    category: classification.category,
    confidence: classification.confidence,
    source: classification.source,
    needs_review: classification.needs_review,
  });
}

export async function syncAllItems(): Promise<ItemSyncResult[]> {
  const items = listItems();
  const results: ItemSyncResult[] = [];
  for (const item of items) {
    const result = await syncOneItem(item);
    results.push(result);
  }
  return results;
}

export async function syncItem(itemId: string): Promise<ItemSyncResult> {
  const item = getItem(itemId);
  if (!item) throw new Error(`item not found: ${itemId}`);
  return syncOneItem(item);
}

// Backfill-classify any txns that are missing a category (e.g. inserted before Phase 2 was ready).
export async function classifyUnclassified(limit = 1000): Promise<{ classified: number; failed: number }> {
  const { listUnclassifiedTransactions } = await import("../db/queries");
  const rows = listUnclassifiedTransactions(limit);
  let classified = 0;
  let failed = 0;
  for (const tx of rows) {
    try {
      const result = await classifyTransaction(tx, { treatAsKnown: false });
      setTransactionClassification({
        id: tx.id,
        category: result.category,
        confidence: result.confidence,
        source: result.source,
        needs_review: result.needs_review,
      });
      classified += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[classify-unclassified] tx ${tx.id} failed:`, (err as Error).message);
      failed += 1;
    }
  }
  return { classified, failed };
}

export type ReclassifyEvent =
  | { type: "start"; total: number }
  | { type: "progress"; index: number; total: number; tx_id: string; category: string; confidence: number; source: string }
  | { type: "error"; tx_id: string; message: string }
  | { type: "done"; classified: number; failed: number };

export async function classifyUnclassifiedStreaming(
  limit: number,
  emit: (event: ReclassifyEvent) => Promise<void>,
): Promise<void> {
  const { listUnclassifiedTransactions } = await import("../db/queries");
  const rows = listUnclassifiedTransactions(limit);
  await emit({ type: "start", total: rows.length });

  let classified = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const tx = rows[i]!;
    try {
      const result = await classifyTransaction(tx, { treatAsKnown: false });
      setTransactionClassification({
        id: tx.id,
        category: result.category,
        confidence: result.confidence,
        source: result.source,
        needs_review: result.needs_review,
      });
      classified += 1;
      await emit({
        type: "progress",
        index: i + 1,
        total: rows.length,
        tx_id: tx.id,
        category: result.category,
        confidence: result.confidence,
        source: result.source,
      });
    } catch (err) {
      failed += 1;
      const message = (err as Error).message ?? "unknown error";
      // eslint-disable-next-line no-console
      console.error(`[classify-unclassified] tx ${tx.id} failed:`, message);
      await emit({ type: "error", tx_id: tx.id, message });
    }
  }
  await emit({ type: "done", classified, failed });
}
