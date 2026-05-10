# Finance Tracker — Build Plan

A self-hosted personal finance tracker that pulls transactions from Plaid, classifies them into fixed buckets via an LLM with merchant-memory caching, and surfaces everything in a dashboard. v1 is dashboard-only; push notifications and v2 features are out of scope.

---

## Goals

- **Primary:** Auto-classify personal transactions into fixed categories so spending can be tracked without manual entry.
- **Self-improving:** Each new merchant is classified once by the LLM, then cached. Manual recategorization writes a permanent rule that overrides future classifications for that merchant.
- **Reviewable:** Low-confidence classifications surface in a "Review" queue. The user accepts or recategorizes; corrections feed back into the merchant cache.
- **Agentic queries (v1.5):** Natural-language questions over the transaction store (e.g. "how much did I spend on dining out last month vs. the previous one") backed by tool-using LLM with read-only DB tools.
- **Out of scope for v1:** push notifications, weekly summary emails, transaction splits, multi-user, mobile app, automatic budgets/alerts.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun | Already in use on the Claude Code dashboard project. Fast startup, native TypeScript, good fetch. |
| Server | Hono | Same as dashboard project. Lightweight, fits well with Bun. |
| DB | SQLite (via `bun:sqlite`) | Local, file-backed, zero ops. FTS5 for merchant search if it gets large. |
| Frontend | React + Vite | Same as dashboard. |
| Bank data | Plaid (free Trial plan, fall back to Sandbox while building) | Best ergonomics for personal-scale account aggregation. |
| LLM provider | Moonshot AI (OpenAI-compatible API at `https://api.moonshot.ai/v1`) | Riley's existing API key and budget. |
| Classification model | `kimi-k2-turbo-preview` (or smallest stable Moonshot model with tool/JSON support at build time) | Cheap, fast, reliable JSON. Confirm exact model ID at build time — Moonshot's lineup shifts. |
| Agent model | `kimi-k2.6` | Strong tool use for the v1.5 query agent. |
| Scheduler | Node-cron in-process (or system cron triggering an HTTP endpoint) | Daily transaction sync. |
| Container | Docker (single image, single container) | Runs on `riley-beelink` or other Linux server. |
| Reverse proxy | Existing Caddy/Tailscale setup | Out of scope for this plan — assume Riley exposes locally and tunnels via Tailscale. |

### Notes on Moonshot

- API is OpenAI-compatible, so use the `openai` Bun-compatible SDK with `baseURL` and `apiKey` overridden.
- **Automatic context caching** (~75% input discount on repeated context) means the long system prompt with the category list is essentially free after the first call. Keep the system prompt stable across requests to maximize this.
- JSON mode is supported via `response_format: { type: "json_object" }`. Validate output with Zod before trusting it; one retry on parse failure.
- Confirm current pricing and exact model IDs in Moonshot console before locking in. Pricing changes have been frequent.

---

## Fixed Categories

```ts
export const CATEGORIES = [
  "Bills/Utilities",
  "Rent/Mortgage",
  "Groceries",
  "Dining Out",
  "Transport",       // gas, rideshare, parking, transit, vehicle maintenance
  "Shopping",        // general retail, household goods
  "Entertainment",   // streaming, games, events, hobbies
  "Health",          // medical, pharmacy, gym, wellness
  "Subscriptions",   // recurring software/services not covered above
  "Travel",          // flights, hotels, lodging
  "Income",
  "Transfer",        // internal transfers between own accounts; should net to ~0 in spending math
  "Other",
] as const;
export type Category = typeof CATEGORIES[number];
```

`Transfer` and `Income` exist specifically so the spending math doesn't double-count internal moves or mistake a paycheck for "income shopping." The classifier MUST be told these exist and how to recognize them.

---

## Data Model

### `accounts`
| col | type | notes |
|---|---|---|
| id | TEXT PK | Plaid `account_id` |
| item_id | TEXT | Plaid `item_id` (the bank connection) |
| name | TEXT | "Chase Sapphire", "Schwab Checking", etc. |
| type | TEXT | depository / credit / etc. |
| mask | TEXT | last 4 digits |
| created_at | INTEGER | epoch ms |

### `transactions`
| col | type | notes |
|---|---|---|
| id | TEXT PK | Plaid `transaction_id` |
| account_id | TEXT FK | |
| amount | REAL | Plaid sign convention: positive = money out. Store as-is and document. |
| iso_currency_code | TEXT | |
| date | TEXT | ISO date (YYYY-MM-DD), the posted/auth date |
| name | TEXT | Plaid `name` (raw merchant string) |
| merchant_name | TEXT NULL | Plaid's cleaned `merchant_name` if present |
| pending | INTEGER | 0/1 |
| plaid_category | TEXT NULL | JSON of Plaid's own categorization, kept as a hint |
| category | TEXT | Our assigned category (one of `CATEGORIES`) |
| confidence | REAL | 0.0–1.0 |
| classification_source | TEXT | `rule` | `llm` | `manual` |
| needs_review | INTEGER | 0/1 (1 if confidence < threshold OR amount > threshold OR new merchant) |
| reviewed_at | INTEGER NULL | epoch ms when user explicitly accepted/corrected |
| created_at | INTEGER | |
| updated_at | INTEGER | |

Indexes: `(date)`, `(category, date)`, `(needs_review)`, `(merchant_name)`.

### `merchant_rules`
The self-improving cache. Lookup is by normalized merchant key.

| col | type | notes |
|---|---|---|
| merchant_key | TEXT PK | normalized (lowercase, strip punctuation/numbers/store IDs); see normalization fn |
| category | Category | |
| confidence | REAL | |
| source | TEXT | `llm` | `manual` |
| sample_name | TEXT | one example raw `name` for debugging |
| hit_count | INTEGER | incremented every time a tx matches this rule |
| created_at | INTEGER | |
| updated_at | INTEGER | bumped when the rule's category changes |

A `manual` rule always wins over an `llm` rule. When the user manually recategorizes a transaction, upsert a `manual` rule. When the user accepts a low-confidence classification, optionally promote the rule's confidence (don't change source — `llm` accepted is still `llm`).

### `plaid_items`
| col | type | notes |
|---|---|---|
| item_id | TEXT PK | |
| access_token | TEXT | encrypt at rest if Riley wants — see Security |
| institution_name | TEXT | |
| cursor | TEXT NULL | Plaid `/transactions/sync` cursor |
| last_synced_at | INTEGER NULL | |

### `sync_log`
For debugging and to surface "last synced" in the UI.

| col | type |
|---|---|
| id | INTEGER PK AUTOINCREMENT |
| item_id | TEXT |
| started_at | INTEGER |
| finished_at | INTEGER NULL |
| added | INTEGER |
| modified | INTEGER |
| removed | INTEGER |
| error | TEXT NULL |

---

## Classification Logic

The path every new transaction takes:

```
1. Normalize merchant key from (merchant_name ?? name).
2. Look up merchant_rules by key.
   - Hit → apply category, source = "rule", confidence = rule.confidence,
     bump hit_count. Done.
3. Miss → call LLM classifier (see prompt below). Receives category + confidence.
4. Upsert merchant_rules with source = "llm".
5. Set needs_review flag if:
     - confidence < 0.75, OR
     - amount > $200 (configurable), OR
     - this was the first-ever sighting of this merchant (regardless of confidence).
```

The "first-ever sighting" review trigger is what gives the system its "show me new things" feel without spamming review for repeat merchants. After Riley accepts the classification, the merchant becomes "known" and future transactions slip through silently unless confidence drops.

### Merchant key normalization

```ts
function merchantKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[#*]+\s*\d+/g, "")     // store numbers like "STORE #1234"
    .replace(/\b\d{3,}\b/g, "")      // long digit runs (phone numbers, IDs)
    .replace(/[^a-z0-9 ]+/g, " ")    // punctuation
    .replace(/\b(llc|inc|co|corp|ltd)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
```

This is a starting heuristic — Riley can tune as edge cases come up. Keep one example raw `sample_name` per rule so it's clear what the key is matching.

### Classification prompt

System prompt (cached automatically by Moonshot — keep stable):

```
You categorize personal financial transactions into exactly one of these categories:
- Bills/Utilities: electric, water, gas, internet, phone, insurance.
- Rent/Mortgage: rent payments, mortgage payments, HOA fees.
- Groceries: supermarkets, grocery stores, food markets. NOT restaurants.
- Dining Out: restaurants, cafes, coffee shops, fast food, food delivery.
- Transport: gas stations, rideshare, parking, transit, vehicle maintenance, tolls.
- Shopping: general retail, household goods, clothing, online marketplaces.
- Entertainment: streaming services, games, events, concerts, hobbies.
- Health: medical, dental, pharmacy, gym, wellness, therapy.
- Subscriptions: recurring software, cloud services, professional tools.
- Travel: flights, hotels, lodging, vacation rentals, travel booking.
- Income: paychecks, deposits, refunds received, interest earned.
- Transfer: movement between the user's own accounts, credit card payments, Venmo/Zelle to self, investment contributions.
- Other: anything that genuinely fits no category above.

Critical:
- Credit card payments and bank-to-bank moves are ALWAYS Transfer, not Bills.
- Amazon, Costco, Target, Walmart default to Shopping unless the merchant string strongly suggests groceries (e.g. "AMZN FRESH").
- A negative amount with no clear merchant from a known income source is Income.
- Output strict JSON: {"category": "<one of above>", "confidence": <0.0-1.0>, "reasoning": "<brief>"}.
- confidence reflects how sure you are; ambiguous merchants like "Amazon" should be ≤ 0.6.
```

User message (one transaction at a time for v1; batch later if cost matters):

```
Merchant: <merchant_name or name>
Raw description: <name>
Amount: <signed amount> <currency>
Date: <date>
Plaid hint (may be wrong): <plaid_category or "none">
```

Validate the response with Zod:
```ts
const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(300),
});
```

On parse failure: log, retry once with `Respond ONLY with JSON.` appended, then fall back to `{ category: "Other", confidence: 0.0, source: "llm" }` and force `needs_review = 1`.

---

## Sync Strategy

Use Plaid's `/transactions/sync` endpoint, which is cursor-based and handles added/modified/removed cleanly. Per Plaid item:

```
1. Read stored cursor for item.
2. Loop:
   - Call /transactions/sync with cursor.
   - For each `added`: upsert tx, classify, write merchant rule if new.
   - For each `modified`: update tx; if amount/merchant changed materially, re-classify.
   - For each `removed`: soft-delete (or hard-delete; Riley's call) the tx.
   - Save next_cursor.
   - If has_more, continue; else break.
3. Stamp last_synced_at, write sync_log row.
```

Sync runs on a schedule (default: daily at 4am local) and via a manual "Sync now" button in the UI.

### Backfill

Per spec, no historical backfill. The first sync for an item will pull whatever Plaid returns by default. Document for Riley that Plaid's first sync for a new item may return ~30 days; that's fine.

---

## API Surface (Hono routes)

All under `/api`. Add basic auth or restrict to LAN/Tailscale at the proxy layer — there's no per-user auth in v1.

### Plaid

| method | path | purpose |
|---|---|---|
| POST | `/api/plaid/link-token` | Create a link_token for Plaid Link UI |
| POST | `/api/plaid/exchange` | Exchange `public_token` → `access_token`, store item, run first sync |
| GET | `/api/plaid/items` | List connected items |
| DELETE | `/api/plaid/items/:itemId` | Remove item (call Plaid `/item/remove`, drop from DB) |

### Sync

| method | path | purpose |
|---|---|---|
| POST | `/api/sync` | Trigger sync of all items (or `?itemId=` for one) |
| GET | `/api/sync/status` | Last sync per item, last error |

### Transactions

| method | path | purpose |
|---|---|---|
| GET | `/api/transactions` | Filterable: `?from=&to=&category=&account=&search=&review=true` |
| GET | `/api/transactions/:id` | Single tx |
| PATCH | `/api/transactions/:id` | Update category (manual recategorization). On change: upsert manual merchant rule, clear `needs_review`, stamp `reviewed_at`, set `classification_source = "manual"`. |
| POST | `/api/transactions/:id/accept` | Accept current classification: clear `needs_review`, stamp `reviewed_at`. |
| POST | `/api/transactions/:id/reclassify` | Re-run LLM (debug / "I think the LLM can do better now") |

### Aggregates

| method | path | purpose |
|---|---|---|
| GET | `/api/summary` | `?from=&to=&groupBy=category\|month` — totals for dashboard |
| GET | `/api/categories` | List categories with counts/totals for current period |

### Merchant rules

| method | path | purpose |
|---|---|---|
| GET | `/api/rules` | List all merchant rules (debug / power-user) |
| PATCH | `/api/rules/:key` | Override a rule's category |
| DELETE | `/api/rules/:key` | Force re-classification next time tx arrives |

### Agent (v1.5)

| method | path | purpose |
|---|---|---|
| POST | `/api/agent/query` | Body: `{ question: string }` → streams natural-language answer |

The agent has read-only DB tools: `query_transactions(filters)`, `summarize_by_category(from, to)`, `compare_periods(...)`. Use Moonshot's tool-calling per their docs; same OpenAI-compatible shape.

---

## Frontend (v1)

Single-page React app. Tailwind for styling unless Riley wants something else.

**Pages:**

1. **Dashboard** (`/`)
   - Top: this-month spend by category (bar or donut), this-month vs. last-month total, last sync time.
   - Recent transactions (last 20).
   - Banner: "N transactions need review" linking to the review queue.

2. **Transactions** (`/transactions`)
   - Filterable, sortable table. Date, merchant, amount, category, account, confidence.
   - Inline category dropdown — click to recategorize.
   - Search box.

3. **Review** (`/review`)
   - Only `needs_review = 1` rows.
   - Big buttons per row: Accept (uses current category), or pick a different category from dropdown.
   - Both actions clear the flag and update the rule.

4. **Settings** (`/settings`)
   - Connected institutions, "Sync now" button, last-sync table.
   - "Connect new institution" → Plaid Link.

5. **Ask** (`/ask`) — v1.5
   - Single input, streamed answer. Show tool calls as a collapsible "thinking" section for debugging.

---

## Build Phases

Each phase is independently shippable. Don't move forward until the previous one works end to end.

### Phase 0 — Project skeleton (½ day)
- `bun init` with Hono + Vite + React.
- SQLite migration runner. Create all tables empty.
- Dockerfile: multi-stage build, Alpine, target ~150–180 MB (same shape as Riley's FastAPI image work).
- `docker-compose.yml` with a bind-mounted SQLite volume so DB survives container restarts.
- Health check endpoint `/api/health`.
- **Done when:** container runs, frontend renders a blank shell, API responds.

### Phase 1 — Plaid integration in Sandbox (1 day)
- Plaid Sandbox credentials in env. Build the link-token + exchange flow.
- Implement `/transactions/sync` loop with cursor persistence.
- Persist accounts and raw transactions (no classification yet).
- Connect a Sandbox bank, verify transactions land in DB.
- **Done when:** "Sync now" pulls Sandbox transactions and shows them on the Transactions page with `category = NULL`.

### Phase 2 — Classification (1–2 days)
- Moonshot client wrapper. Env-driven model IDs.
- Implement `merchantKey()` and the rule lookup → LLM fallback flow.
- Wire classification into the sync handler (every added/modified tx flows through it).
- Add `needs_review` logic.
- Backfill-classify any rows that came in during Phase 1.
- **Done when:** every tx has a category, confidence, and source. Repeat syncs hit `merchant_rules` and don't call the LLM.

### Phase 3 — Review queue + manual override (½ day)
- Build the Review page UI.
- `PATCH /transactions/:id` with rule upsert.
- "Accept" and "Recategorize" actions both clear `needs_review`.
- **Done when:** Riley can correct a transaction once and never see that merchant misclassified again.

### Phase 4 — Dashboard + summaries (1 day)
- Build the dashboard page with category breakdown chart and month-over-month comparison.
- `/api/summary` endpoint.
- **Done when:** Dashboard renders accurate totals, excluding `Transfer` and `Income` from "spending" math.

### Phase 5 — Production Plaid (½ day)
- Apply for Plaid Trial plan if not already on one. Migrate from Sandbox to Production credentials.
- Connect real accounts (start with one, expand).
- Cron the daily sync.
- **Done when:** real transactions are syncing daily with correct classifications.

### Phase 6 — Agentic queries (1–2 days, can defer)
- Define DB-read tools.
- Build `/api/agent/query` with Moonshot tool calling using `kimi-k2.6`.
- Stream response to the Ask page.
- **Done when:** "What's my dining-out trend over the last 3 months?" returns a coherent answer with the right numbers.

---

## Security & Privacy

This is a personal app on a private network, but it handles bank data, so:

- **Plaid access tokens at rest:** XOR with a key from env, or use Bun's `crypto.subtle` AES-GCM. Do this from day one — easier than retrofitting.
- **API key for Moonshot:** env only, never in DB or logs.
- **No auth in v1:** assume Tailscale-only access. Document this clearly. If Riley exposes externally, add basic auth before doing so.
- **Logging:** never log full transaction descriptions or amounts to anything that leaves the box. Redact or hash for any external telemetry.
- **DB backups:** nightly `sqlite3 .backup` to a second location on the host. SQLite is one file but it's the file.

---

## Open Questions / Future Work (post-v1)

- **Push notifications (v2):** weekly summary, "you're trending high on dining out" alerts, large/unusual transaction flags.
- **Budgets:** per-category monthly target with progress bars.
- **Splits:** if Costco/Amazon ambiguity gets annoying, add per-tx split editor.
- **Recurring detection:** auto-flag subscriptions and surface "you have N recurring charges totaling $X/mo".
- **Cash transactions:** manual entry for cash spending if Riley cares.
- **Multi-currency:** assumes USD throughout; revisit if travel category gets foreign txs frequently.
- **Confidence calibration:** track accept/correct rate per confidence bucket; adjust the review threshold if the LLM is over- or under-confident.

---

## Initial Env Vars

```
# Plaid
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox        # sandbox | production
PLAID_PRODUCTS=transactions
PLAID_COUNTRY_CODES=US
PLAID_REDIRECT_URI=      # if using OAuth institutions

# Moonshot
MOONSHOT_API_KEY=
MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
MOONSHOT_CLASSIFY_MODEL=kimi-k2-turbo-preview   # confirm at build time
MOONSHOT_AGENT_MODEL=kimi-k2.6

# App
DB_PATH=/data/finance.db
ENCRYPTION_KEY=          # 32-byte random, base64
PORT=8080
TZ=America/Denver
REVIEW_CONFIDENCE_THRESHOLD=0.75
REVIEW_AMOUNT_THRESHOLD=200
SYNC_CRON=0 4 * * *      # daily 4am
```

---

## Hand-off Notes for Claude Code

- Verify exact Moonshot model IDs and pricing in their console before locking the env defaults — the lineup has been changing.
- For Plaid, sign up at https://dashboard.plaid.com — Trial plans (10 production Items) are free for accounts created after April 15, 2026 and cover personal use.
- Confirm Plaid `/transactions/sync` is available on Trial; if not, use `/transactions/get` with date windows as a fallback (uglier, but works).
- Keep the system prompt for classification stable across calls. Moonshot caches it automatically and the cost difference is real over thousands of transactions.
- The merchant key normalization function will need tuning. Add a debug page that lists `(raw_name → merchant_key → matched_rule)` so Riley can see what's collapsing where.
- Do NOT batch classification calls in v1. One tx per call is simpler, easier to debug, and the cost is negligible at personal scale. Revisit if backfill ever becomes a thing.
