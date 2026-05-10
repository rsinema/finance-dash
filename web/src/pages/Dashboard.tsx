import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import {
  api,
  type SummaryByCategory,
  type SummaryByMonth,
  type Transaction,
  type SyncStatus,
} from "../lib/api";
import { CATEGORY_COLORS, NON_SPENDING, type Category } from "../lib/categories";
import {
  fmtMoney,
  fmtRelative,
  firstOfMonthISO,
  firstOfPreviousMonthISO,
  lastOfPreviousMonthISO,
  todayISO,
  fmtDate,
  fmtMoneySigned,
} from "../lib/format";
import { CategoryPill } from "../components/CategoryPill";

type RangeMode = "month" | "all";

export function Dashboard() {
  const [thisMonth, setThisMonth] = useState<SummaryByCategory | null>(null);
  const [lastMonth, setLastMonth] = useState<SummaryByCategory | null>(null);
  const [byMonth, setByMonth] = useState<SummaryByMonth | null>(null);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus[]>([]);
  const [rangeMode, setRangeMode] = useState<RangeMode>("month");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const tm = firstOfMonthISO();
    const today = todayISO();
    const lmStart = firstOfPreviousMonthISO();
    const lmEnd = lastOfPreviousMonthISO();
    const [tmRes, lmRes, monthsRes, recentRes, reviewRes, statusRes] = await Promise.all([
      api.summaryByCategory(tm, today),
      api.summaryByCategory(lmStart, lmEnd),
      api.summaryByMonth(),
      api.listTransactions({ limit: 20 }),
      api.listTransactions({ review: true, limit: 1 }),
      api.syncStatus(),
    ]);

    // Auto-fall back to all-time if "this month" is empty but there are transactions overall.
    // Common case: Plaid sandbox dates land outside the current calendar month.
    const tmHasSpending = (tmRes.buckets ?? []).some(
      (b) => b.category && b.category !== "Income" && b.category !== "Transfer",
    );
    let effective = tmRes;
    let mode: RangeMode = "month";
    if (!tmHasSpending && recentRes.total > 0) {
      effective = await api.summaryByCategory();
      mode = "all";
    }

    setThisMonth(effective);
    setLastMonth(lmRes);
    setByMonth(monthsRes);
    setRecent(recentRes.transactions);
    setReviewCount(reviewRes.total);
    setSyncStatus(statusRes.items);
    setRangeMode(mode);
  }

  const lastSync = syncStatus.reduce<number | null>((max, s) => {
    const t = s.finished_at ?? s.started_at;
    return max == null || (t && t > max) ? t : max;
  }, null);

  const spendingBuckets =
    thisMonth?.buckets.filter(
      (b) => b.category && !NON_SPENDING.has(b.category as Category),
    ) ?? [];

  const monthOverMonthDelta =
    thisMonth && lastMonth ? thisMonth.spending_total - lastMonth.spending_total : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <div className="text-sm text-muted">
            Last sync: {fmtRelative(lastSync)}
          </div>
        </div>
        <button
          className="btn"
          onClick={async () => {
            await api.sync();
            void load();
          }}
        >
          Sync now
        </button>
      </div>

      {reviewCount > 0 && (
        <Link
          to="/review"
          className="block panel p-4 border-accent/40 bg-accent/5 hover:bg-accent/10 transition-colors"
        >
          <span className="text-accent font-medium">{reviewCount}</span>{" "}
          <span className="text-text/80">transactions need review →</span>
        </Link>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="panel p-5">
          <div className="text-xs text-muted uppercase tracking-wide">
            {rangeMode === "all" ? "All time" : "This month"}
          </div>
          <div className="text-3xl font-semibold mt-1">
            {fmtMoney(thisMonth?.spending_total ?? 0)}
          </div>
          <div className="text-sm text-muted mt-1">
            {rangeMode === "month"
              ? `${monthOverMonthDelta >= 0 ? "+" : ""}${fmtMoney(monthOverMonthDelta)} vs last month`
              : "spending across all transactions"}
          </div>
        </div>
        <div className="panel p-5">
          <div className="text-xs text-muted uppercase tracking-wide">Income</div>
          <div className="text-3xl font-semibold mt-1">
            {fmtMoney(thisMonth?.income_total ?? 0)}
          </div>
          <div className="text-sm text-muted mt-1">
            {rangeMode === "month" ? "this month" : "all time"}
          </div>
        </div>
        <div className="panel p-5">
          <div className="text-xs text-muted uppercase tracking-wide">Net</div>
          <div className="text-3xl font-semibold mt-1">
            {fmtMoney(
              (thisMonth?.income_total ?? 0) - (thisMonth?.spending_total ?? 0),
            )}
          </div>
          <div className="text-sm text-muted mt-1">income − spending</div>
        </div>
      </div>

      {rangeMode === "all" && (
        <div className="text-xs text-muted -mt-2">
          No transactions in the current calendar month — showing all-time totals instead.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="panel p-5">
          <div className="text-sm font-medium mb-4">
            Spending by category
            <span className="ml-2 text-xs text-muted font-normal">
              ({rangeMode === "all" ? "all time" : "this month"})
            </span>
          </div>
          {spendingBuckets.length === 0 ? (
            <div className="text-muted text-sm py-12 text-center">
              No data yet — connect a bank to see your spending.
            </div>
          ) : (
            <div className="flex items-center gap-6">
              <div className="w-48 h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={spendingBuckets}
                      dataKey="total"
                      nameKey="category"
                      innerRadius={50}
                      outerRadius={85}
                      stroke="none"
                    >
                      {spendingBuckets.map((b) => (
                        <Cell
                          key={b.category}
                          fill={CATEGORY_COLORS[b.category as Category] ?? "#888"}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "#13161b",
                        border: "1px solid #222831",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: number) => fmtMoney(v)}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1.5">
                {spendingBuckets.slice(0, 8).map((b) => (
                  <div key={b.category} className="flex justify-between text-sm">
                    <CategoryPill category={b.category as Category} />
                    <span>{fmtMoney(b.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="panel p-5">
          <div className="text-sm font-medium mb-4">Last 6 months</div>
          {byMonth && byMonth.buckets.length > 0 ? (
            <div className="space-y-2">
              {byMonth.buckets.slice(0, 6).map((b) => {
                const max = Math.max(...byMonth.buckets.map((x) => x.total));
                const pct = max > 0 ? (b.total / max) * 100 : 0;
                return (
                  <div key={b.month}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-muted">{b.month}</span>
                      <span>{fmtMoney(b.total)}</span>
                    </div>
                    <div className="h-2 bg-bg rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent/70"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-muted text-sm py-12 text-center">No history yet.</div>
          )}
        </div>
      </div>

      <div className="panel p-5">
        <div className="text-sm font-medium mb-4">Recent transactions</div>
        {recent.length === 0 ? (
          <div className="text-muted text-sm py-8 text-center">
            No transactions yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 font-medium">Date</th>
                <th className="text-left py-2 font-medium">Merchant</th>
                <th className="text-left py-2 font-medium">Category</th>
                <th className="text-right py-2 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className="border-t border-border/60">
                  <td className="py-2 text-muted">{fmtDate(t.date)}</td>
                  <td className="py-2">
                    {t.merchant_name ?? t.name}
                    {t.pending ? (
                      <span className="ml-2 text-xs text-muted">(pending)</span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <CategoryPill category={t.category} />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {fmtMoneySigned(t.amount, t.iso_currency_code ?? "USD")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
