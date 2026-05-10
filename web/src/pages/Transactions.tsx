import { useEffect, useState } from "react";
import { api, type Transaction } from "../lib/api";
import { CATEGORIES, type Category } from "../lib/categories";
import { CategoryPill } from "../components/CategoryPill";
import { CategorySelect } from "../components/CategorySelect";
import { fmtDate, fmtMoneySigned } from "../lib/format";

export function Transactions() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const limit = 100;

  useEffect(() => {
    void load();
  }, [search, category, from, to, offset]);

  async function load() {
    const res = await api.listTransactions({
      limit,
      offset,
      search: search || undefined,
      category: category || undefined,
      from: from || undefined,
      to: to || undefined,
    });
    setRows(res.transactions);
    setTotal(res.total);
  }

  async function handleCategoryChange(id: string, next: Category) {
    await api.patchTransaction(id, next);
    setEditing(null);
    void load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <div className="text-sm text-muted">
          {total.toLocaleString()} total
        </div>
      </div>

      <div className="panel p-4 flex flex-wrap gap-2">
        <input
          className="input flex-1 min-w-[180px]"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className="input"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="input"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          className="input"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {(search || category || from || to) && (
          <button
            className="btn"
            onClick={() => {
              setSearch("");
              setCategory("");
              setFrom("");
              setTo("");
              setOffset(0);
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted uppercase tracking-wide bg-bg/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">Merchant</th>
              <th className="text-left px-4 py-2 font-medium">Category</th>
              <th className="text-left px-4 py-2 font-medium">Source</th>
              <th className="text-right px-4 py-2 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-border/60">
                <td className="px-4 py-2 text-muted whitespace-nowrap">{fmtDate(t.date)}</td>
                <td className="px-4 py-2">
                  <div>{t.merchant_name ?? t.name}</div>
                  {t.merchant_name && t.merchant_name !== t.name && (
                    <div className="text-xs text-muted">{t.name}</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  {editing === t.id ? (
                    <CategorySelect
                      value={t.category}
                      onChange={(next) => handleCategoryChange(t.id, next)}
                    />
                  ) : (
                    <button onClick={() => setEditing(t.id)} className="text-left">
                      <CategoryPill category={t.category} />
                    </button>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted">
                  {t.classification_source ?? "—"}
                  {t.confidence != null && (
                    <span className="ml-1">
                      {(t.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                  {fmtMoneySigned(t.amount, t.iso_currency_code ?? "USD")}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted">
                  No transactions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="flex items-center justify-between text-sm">
          <button
            className="btn"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            ← Previous
          </button>
          <span className="text-muted">
            {offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}
          </span>
          <button
            className="btn"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
