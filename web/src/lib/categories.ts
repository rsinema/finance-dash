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

export const CATEGORY_COLORS: Record<Category, string> = {
  "Bills/Utilities": "#f4a261",
  "Rent/Mortgage": "#e76f51",
  Groceries: "#2a9d8f",
  "Dining Out": "#e9c46a",
  Transport: "#90be6d",
  Shopping: "#9d7cd8",
  Entertainment: "#f08080",
  Health: "#67b8d6",
  Subscriptions: "#b18cff",
  Travel: "#48cae4",
  Income: "#3aa676",
  Transfer: "#7a8290",
  Other: "#c0c8d4",
};

export const NON_SPENDING: ReadonlySet<Category> = new Set(["Income", "Transfer"]);
