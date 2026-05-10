import { useEffect, useState } from "react";
import { api, type Transaction } from "../lib/api";
import { type Category } from "../lib/categories";
import { CategoryPill } from "../components/CategoryPill";
import { CategorySelect } from "../components/CategorySelect";
import { fmtDate, fmtMoneySigned } from "../lib/format";

export function Review() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const res = await api.listTransactions({ review: true, limit: 200 });
    setRows(res.transactions);
  }

  async function accept(id: string) {
    setBusy(id);
    await api.acceptTransaction(id);
    await load();
    setBusy(null);
  }

  async function recategorize(id: string, next: Category) {
    setBusy(id);
    await api.patchTransaction(id, next);
    await load();
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Review queue</h1>
        <div className="text-sm text-muted">
          New merchants and low-confidence classifications. Accept to keep, or pick a different
          category — the rule sticks for next time.
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel p-12 text-center text-muted">
          Nothing to review. Sync to surface new transactions.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((t) => (
            <div key={t.id} className="panel p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{t.merchant_name ?? t.name}</div>
                <div className="text-xs text-muted truncate">
                  {fmtDate(t.date)} · {t.name}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <CategoryPill category={t.category} />
                  {t.confidence != null && (
                    <span className="text-muted">
                      {(t.confidence * 100).toFixed(0)}% confidence
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right tabular-nums whitespace-nowrap">
                {fmtMoneySigned(t.amount, t.iso_currency_code ?? "USD")}
              </div>
              <div className="flex items-center gap-2">
                <CategorySelect
                  value={t.category}
                  onChange={(next) => recategorize(t.id, next)}
                  disabled={busy === t.id}
                />
                <button
                  className="btn-primary"
                  disabled={busy === t.id || !t.category}
                  onClick={() => accept(t.id)}
                >
                  Accept
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
