# Finance Tracker

Self-hosted personal finance tracker. Pulls transactions from Plaid, classifies them with an LLM (Moonshot Kimi) cached per-merchant, and surfaces everything in a dashboard.

## Quick start

### 1. Configure environment

```bash
cp .env.example .env
```

Fill in:
- `PLAID_CLIENT_ID` / `PLAID_SECRET` — from <https://dashboard.plaid.com>. Start with `PLAID_ENV=sandbox`.
- `MOONSHOT_API_KEY` — from <https://platform.moonshot.ai>. Optional; without it, classifications default to `Other`.
- `ENCRYPTION_KEY` — 32 bytes, base64. Generate with: `bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"`.

### 2. Install + run (dev)

```bash
bun install
bun run --filter server migrate     # creates ./data/finance.db
bun run dev                          # starts API on :8090 and Vite on :5173
```

Open <http://localhost:5173> for the UI. Vite proxies `/api` → `:8090`.

### 3. Run (Docker, build from source)

```bash
docker compose up -d --build
```

UI + API on <http://localhost:8090>. SQLite lives in `./data/finance.db`.

### 4. Run (Docker, pull prebuilt image)

The fastest path to deploy on a fresh Linux box. No source code transfer needed.

```bash
mkdir -p ~/finiance-dash/data && cd ~/finiance-dash
curl -O https://raw.githubusercontent.com/rsinema/finiance-dash/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/rsinema/finiance-dash/main/.env.example
mv .env.example .env
nano .env   # fill in PLAID_*, MOONSHOT_API_KEY, ENCRYPTION_KEY, S3_*

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f --tail=50
```

To upgrade later when a new image is published:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The image is multi-arch (`linux/amd64`, `linux/arm64`) — Docker pulls the right variant automatically.

## Architecture

Workspace layout:

- `server/` — Bun + Hono API. SQLite via `bun:sqlite`. Plaid sync, classification, agent.
- `web/` — Vite + React + Tailwind dashboard.

Sync flow: cron (default 4am local) hits Plaid `/transactions/sync` per item, persists added/modified/removed, then classifies each new transaction. Manual "Sync now" button on the Settings page does the same on demand.

Classification flow:
1. Normalize the merchant string into a stable key (`server/src/lib/merchant.ts`).
2. Look up `merchant_rules`. Hit → done.
3. Miss → call Moonshot. Persist as an `llm` rule.
4. Flag for review if confidence is low, the amount is large, or it's the first time we've seen this merchant.

Manual recategorization writes a `manual` rule, which permanently overrides any `llm` rule for that merchant key.

## Categories

Fixed list in `server/src/lib/categories.ts`. `Income` and `Transfer` are excluded from "spending" math so paychecks and credit-card payments don't pollute totals.

## Routes

- `POST /api/plaid/link-token` — start a Plaid Link flow
- `POST /api/plaid/exchange` — exchange the public token, store the access token (encrypted), kick off first sync
- `GET /api/plaid/items` / `DELETE /api/plaid/items/:itemId`
- `POST /api/sync[?itemId=]` — trigger sync; `GET /api/sync/status`
- `GET /api/transactions` (filterable) / `GET /api/transactions/:id`
- `PATCH /api/transactions/:id` — manual recategorize (writes a manual rule)
- `POST /api/transactions/:id/accept` — mark reviewed without changing category
- `POST /api/transactions/:id/reclassify` — re-run the classifier
- `GET /api/summary?groupBy=category|month`
- `GET /api/rules` / `PATCH /api/rules/:key` / `DELETE /api/rules/:key`
- `POST /api/agent/query` — streaming agent response (NDJSON)

## Backups

### Local snapshots

In-process SQLite snapshots via `VACUUM INTO`, scheduled by `BACKUP_CRON` (default `30 4 * * *` — 30 minutes after the daily sync). Files land in `BACKUP_DIR` (default `./data/backups`, mounted into the container alongside the live DB) named `finance-<ISO timestamp>.db`. The newest `BACKUP_RETAIN` (default 14) are kept; older snapshots are pruned automatically.

- Manual trigger: `POST /api/backups` (or "Back up now" on the Settings page).
- List existing backups: `GET /api/backups`.
- Disable scheduled backups with `BACKUP_ENABLED=false`.

### Off-host: S3

If `S3_BUCKET` is set, every snapshot (cron or manual) is also uploaded to S3 with SSE-S3 (AES-256) server-side encryption. Files land at `s3://$S3_BUCKET/$S3_PREFIX/finance-<timestamp>.db`. Default S3 retention is `S3_RETAIN=90` snapshots, pruned independently of the local retention.

Credentials use the standard AWS chain — set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` in `.env`, or attach an IAM instance role to the host.

S3-compatible providers (Cloudflare R2, MinIO, Backblaze B2 with S3 API): set `S3_ENDPOINT_URL` and `S3_FORCE_PATH_STYLE=true` (MinIO requires path-style).

#### IAM policy

Create an IAM user dedicated to this app. Attach the following inline policy. Replace `YOUR-BUCKET` with your bucket name; if you change `S3_PREFIX` from the default, update `finiance-dash` in the resource ARNs and the `s3:prefix` condition to match.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/finiance-dash/*"
    },
    {
      "Sid": "BackupList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR-BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["finiance-dash/*", "finiance-dash/"]
        }
      }
    }
  ]
}
```

Permission breakdown — what each action is used for:

- `s3:PutObject` — uploading the snapshot.
- `s3:ListBucket` — discovering existing snapshots for retention pruning and the Settings UI table.
- `s3:DeleteObject` — pruning snapshots beyond `S3_RETAIN`.
- `s3:GetObject` — restoring a snapshot via the `restore-from-s3` script.

If you want even tighter scope, drop `s3:DeleteObject` and rely on a bucket lifecycle rule (e.g. delete objects older than 90 days) for retention instead. The app will log a warning when pruning fails but won't crash.

Bucket-side recommendations (configure in the AWS console, not via this app):

- **Block all public access** (default).
- **Enable bucket versioning** so a malicious or buggy delete leaves a recoverable history.
- **Enable default encryption** (SSE-S3 is fine; the uploads also request SSE-S3 explicitly).
- Optional **lifecycle rule** transitioning to `STANDARD_IA` after 30 days and expiring at 365 days for cheaper long-term retention. (Or set `S3_STORAGE_CLASS=STANDARD_IA` to upload directly into the cheaper tier — note the 30-day minimum storage charge applies.)

### Restoring

Local backup:

```bash
docker compose down
mv data/finance.db data/finance.db.bak
cp data/backups/finance-2026-05-09T04-30-00-000.db data/finance.db
rm -f data/finance.db-shm data/finance.db-wal
docker compose up -d
```

S3 backup:

```bash
# Downloads the newest S3 backup to ./data/restore.db (refuses to overwrite an existing file).
bun run server/src/scripts/restore-from-s3.ts

# Or download a specific key:
bun run server/src/scripts/restore-from-s3.ts finiance-dash/finance-2026-05-09T04-30-00-000.db

# Then follow the same swap-and-restart steps as a local restore.
```

## Security

- Plaid access tokens are AES-GCM encrypted at rest using `ENCRYPTION_KEY`.
- No user auth in v1. Set `APP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on `/api/*` if exposing beyond Tailscale.
- Don't log full transaction descriptions to anything that leaves the box.

## Known limitations

- USD-centric (multi-currency display works but math assumes one currency).
- No transaction splits (Costco/Amazon ambiguity goes whole-receipt to one category).
- No notifications, budgets, or weekly summaries (deferred to v2 per build plan).
