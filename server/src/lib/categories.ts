export const CATEGORIES = [
  "Bills/Utilities",
  "Rent/Mortgage",
  "Groceries",
  "Dining Out",
  "Transport",
  "Shopping",
  "Entertainment",
  "Health",
  "Subscriptions",
  "Travel",
  "Income",
  "Transfer",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

export function isCategory(s: string): s is Category {
  return CATEGORY_SET.has(s);
}

// Categories excluded from "spending" math (don't count toward burn-rate).
export const NON_SPENDING_CATEGORIES: ReadonlySet<Category> = new Set([
  "Income",
  "Transfer",
]);
