// Normalize a merchant string into a stable lookup key for the rules cache.
// Strips store numbers, long digit runs, punctuation, and corp suffixes.
export function merchantKey(raw: string): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[#*]+\s*\d+/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(llc|inc|co|corp|ltd|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
