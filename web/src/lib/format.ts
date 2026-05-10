const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function fmtMoney(amount: number, currency = "USD"): string {
  if (currency !== "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  return usd.format(amount);
}

export function fmtMoneySigned(amount: number, currency = "USD"): string {
  // Plaid: positive = money out, negative = money in. Display from the user's perspective:
  // outflow as -$X, inflow as +$X.
  const display = -amount;
  const sign = display >= 0 ? "+" : "";
  return `${sign}${fmtMoney(display, currency)}`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtRelative(epochMs: number | null): string {
  if (!epochMs) return "never";
  const diff = Date.now() - epochMs;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export function firstOfMonthISO(date = new Date()): string {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
}

export function firstOfPreviousMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10);
}

export function lastOfPreviousMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10);
}
