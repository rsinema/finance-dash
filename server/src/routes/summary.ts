import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db";
import { CATEGORIES, NON_SPENDING_CATEGORIES } from "../lib/categories";

export const summaryRouter = new Hono();

const SummaryQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(["category", "month"]).default("category"),
});

interface CategoryAggRow {
  category: string | null;
  total: number;
  count: number;
}

interface MonthAggRow {
  month: string;
  total: number;
  count: number;
}

summaryRouter.get("/", zValidator("query", SummaryQuery), (c) => {
  const { from, to, groupBy } = c.req.valid("query");

  const where: string[] = ["deleted_at IS NULL"];
  const args: (string | number)[] = [];
  if (from) {
    where.push("date >= ?");
    args.push(from);
  }
  if (to) {
    where.push("date <= ?");
    args.push(to);
  }
  const whereClause = `WHERE ${where.join(" AND ")}`;

  if (groupBy === "category") {
    const rows = db()
      .query<CategoryAggRow, (string | number)[]>(
        `SELECT category, SUM(amount) as total, COUNT(*) as count
         FROM transactions
         ${whereClause}
         GROUP BY category
         ORDER BY total DESC`,
      )
      .all(...args);

    const spendingTotal = rows
      .filter((r) => r.category && !NON_SPENDING_CATEGORIES.has(r.category as never))
      .reduce((acc, r) => acc + (r.total ?? 0), 0);
    const incomeTotal = -1 * (rows.find((r) => r.category === "Income")?.total ?? 0);

    return c.json({
      groupBy: "category" as const,
      from: from ?? null,
      to: to ?? null,
      buckets: rows.map((r) => ({
        category: r.category ?? "Unclassified",
        total: r.total ?? 0,
        count: r.count,
      })),
      spending_total: spendingTotal,
      income_total: incomeTotal,
    });
  }

  const rows = db()
    .query<MonthAggRow, (string | number)[]>(
      `SELECT substr(date, 1, 7) as month, SUM(amount) as total, COUNT(*) as count
       FROM transactions
       ${whereClause}
       AND category NOT IN ('Income', 'Transfer')
       GROUP BY month
       ORDER BY month DESC`,
    )
    .all(...args);

  return c.json({
    groupBy: "month" as const,
    from: from ?? null,
    to: to ?? null,
    buckets: rows,
  });
});

summaryRouter.get("/categories", (c) => {
  return c.json({
    categories: CATEGORIES,
    non_spending: Array.from(NON_SPENDING_CATEGORIES),
  });
});
