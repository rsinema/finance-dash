// Smoke test: exercises the classification + rule pipeline against a real local DB.
// Doesn't talk to Plaid or Moonshot — meant to verify wiring after Phase 0/2/3 changes.
//
// Run with: DB_PATH=./data/smoke.db bun run server/src/scripts/smoke.ts

import { db } from "../db";
import { runMigrations } from "../db/migrate";
import {
  getRule,
  getTransaction,
  upsertAccount,
  upsertItem,
  upsertTransaction,
} from "../db/queries";
import { applyManualClassification, classifyTransaction } from "../services/classifier";
import { merchantKey } from "../lib/merchant";

async function main() {
  runMigrations();

  // Seed an item + account + transaction directly.
  upsertItem({
    item_id: "smoke-item",
    access_token_enc: "plain:fake",
    institution_id: null,
    institution_name: "Smoke Bank",
  });
  upsertAccount({
    id: "smoke-acct",
    item_id: "smoke-item",
    name: "Checking",
    official_name: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    currency: "USD",
  });
  upsertTransaction({
    id: "smoke-tx-1",
    account_id: "smoke-acct",
    amount: 12.34,
    iso_currency_code: "USD",
    date: "2026-05-09",
    authorized_date: null,
    name: "STARBUCKS STORE #1234",
    merchant_name: "Starbucks",
    pending: false,
    plaid_category: null,
  });

  // Classify (will fall back to "Other" with confidence 0 since MOONSHOT_API_KEY likely unset).
  const tx = getTransaction("smoke-tx-1")!;
  const result = await classifyTransaction(tx, { treatAsKnown: false });
  console.log("[smoke] classified:", result);

  // Apply a manual override and confirm a manual rule lands in the cache.
  applyManualClassification({
    rawMerchant: tx.merchant_name ?? tx.name,
    category: "Dining Out",
  });
  const key = merchantKey(tx.merchant_name ?? tx.name);
  const rule = getRule(key);
  if (!rule || rule.source !== "manual" || rule.category !== "Dining Out") {
    throw new Error(`expected manual rule for '${key}', got ${JSON.stringify(rule)}`);
  }
  console.log("[smoke] manual rule:", rule);

  // Re-classify same merchant via a new transaction — should now hit the rule.
  upsertTransaction({
    id: "smoke-tx-2",
    account_id: "smoke-acct",
    amount: 4.5,
    iso_currency_code: "USD",
    date: "2026-05-09",
    authorized_date: null,
    name: "STARBUCKS STORE #5678",
    merchant_name: "Starbucks",
    pending: false,
    plaid_category: null,
  });
  const tx2 = getTransaction("smoke-tx-2")!;
  const result2 = await classifyTransaction(tx2, { treatAsKnown: false });
  if (result2.source !== "rule" || result2.category !== "Dining Out") {
    throw new Error(`expected rule hit for second tx, got ${JSON.stringify(result2)}`);
  }
  console.log("[smoke] rule hit on second tx:", result2);

  console.log("\n[smoke] PASS");
  db().close();
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
