import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { api, type PlaidItemDescriptor, type SyncStatus } from "../lib/api";
import { fmtRelative } from "../lib/format";

interface LocalBackup {
  name: string;
  bytes: number;
  mtime: number;
}

interface S3Backup {
  key: string;
  filename: string;
  bytes: number;
  lastModified: number | null;
}

interface S3Info {
  enabled: boolean;
  bucket: string;
  prefix: string;
  backups: S3Backup[];
  error?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Settings() {
  const [items, setItems] = useState<PlaidItemDescriptor[]>([]);
  const [status, setStatus] = useState<SyncStatus[]>([]);
  const [backups, setBackups] = useState<LocalBackup[]>([]);
  const [s3Info, setS3Info] = useState<S3Info | null>(null);
  const [plaidConfigured, setPlaidConfigured] = useState<boolean | null>(null);
  const [plaidEnv, setPlaidEnv] = useState<string>("");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loadingLink, setLoadingLink] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyProgress, setReclassifyProgress] = useState<{
    current: number;
    total: number;
    classified: number;
    failed: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, s, b, p] = await Promise.all([
      api.listItems(),
      api.syncStatus(),
      api.listBackups(),
      api.plaidStatus().catch(() => ({ configured: false, env: "" })),
    ]);
    setItems(i.items);
    setStatus(s.items);
    setBackups(b.local);
    setS3Info(b.s3);
    setPlaidConfigured(p.configured);
    setPlaidEnv(p.env);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      try {
        setError(null);
        await api.exchangePublicToken(publicToken);
        await load();
        setLinkToken(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [load],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess,
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function startLink() {
    setLoadingLink(true);
    setError(null);
    try {
      const { link_token } = await api.createLinkToken();
      setLinkToken(link_token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingLink(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await api.sync();
      await load();
    } finally {
      setSyncing(false);
    }
  }

  async function removeItem(itemId: string) {
    if (!confirm("Remove this institution? Transactions will remain in the database.")) return;
    await api.removeItem(itemId);
    await load();
  }

  async function backupNow() {
    setBackingUp(true);
    try {
      await api.createBackup();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBackingUp(false);
    }
  }

  async function reclassifyFailed() {
    setError(null);
    setReclassifying(true);
    setReclassifyProgress(null);
    try {
      const res = await api.reclassifyFailed();
      const total = res.classified + res.failed;
      setReclassifyProgress({
        current: total,
        total,
        classified: res.classified,
        failed: res.failed,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReclassifying(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {error && (
        <div className="panel p-3 text-sm bg-red-500/10 border-red-500/30 text-red-300">
          {error}
        </div>
      )}

      <div className="panel p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">
              Connected institutions
              {plaidEnv && (
                <span className="ml-2 text-xs text-muted uppercase tracking-wide">
                  {plaidEnv}
                </span>
              )}
            </div>
            <div className="text-sm text-muted">
              {items.length} {items.length === 1 ? "bank" : "banks"} linked via Plaid.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn"
              onClick={reclassifyFailed}
              disabled={reclassifying}
              title="Retry classification on transactions that fell back to 'Other'"
            >
              {reclassifying ? "Reclassifying…" : "Reclassify failed"}
            </button>
            <button className="btn" onClick={syncNow} disabled={syncing || items.length === 0}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              className="btn-primary"
              onClick={startLink}
              disabled={loadingLink || plaidConfigured === false}
              title={plaidConfigured === false ? "Plaid is not configured" : undefined}
            >
              {loadingLink ? "Loading…" : "Connect new"}
            </button>
          </div>
        </div>

        {plaidConfigured === false && (
          <div className="text-sm bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 rounded-md p-3">
            Plaid isn't configured. Set <code className="font-mono">PLAID_CLIENT_ID</code> and{" "}
            <code className="font-mono">PLAID_SECRET</code> in <code className="font-mono">.env</code>, then restart the server.
          </div>
        )}

        {reclassifyProgress && !reclassifying && (
          <div className="text-sm text-muted">
            {reclassifyProgress.total === 0
              ? "Nothing to reclassify — all transactions already have a confident classification."
              : `Done: ${reclassifyProgress.classified} classified, ${reclassifyProgress.failed} failed.`}
          </div>
        )}

        {items.length === 0 ? (
          <div className="text-muted text-sm py-4 text-center">
            No institutions yet. Click "Connect new" to add one.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {items.map((item) => {
              const s = status.find((x) => x.item_id === item.item_id);
              return (
                <div key={item.item_id} className="py-3 flex items-center justify-between">
                  <div>
                    <div>{item.institution_name ?? item.item_id}</div>
                    <div className="text-xs text-muted">
                      Last sync: {fmtRelative(item.last_synced_at)}
                      {s?.error ? <span className="text-red-400"> · error: {s.error}</span> : null}
                    </div>
                  </div>
                  <button
                    className="btn"
                    onClick={() => removeItem(item.item_id)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-medium">Backups</div>
            <div className="text-sm text-muted">
              Local SQLite snapshots via VACUUM INTO. Daily cron prunes to retention limit.
              {s3Info?.enabled ? " Each snapshot also uploads to S3." : " S3 off-host backup is disabled."}
            </div>
          </div>
          <button className="btn" onClick={backupNow} disabled={backingUp}>
            {backingUp ? "Backing up…" : "Back up now"}
          </button>
        </div>

        <div className="text-xs uppercase tracking-wide text-muted mb-2">Local</div>
        {backups.length === 0 ? (
          <div className="text-muted text-sm mb-4">No local backups yet.</div>
        ) : (
          <table className="w-full text-sm mb-4">
            <thead className="text-xs text-muted uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 font-medium">File</th>
                <th className="text-right py-2 font-medium">Size</th>
                <th className="text-right py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.name} className="border-t border-border/60">
                  <td className="py-2 font-mono text-xs">{b.name}</td>
                  <td className="py-2 text-right tabular-nums">{fmtBytes(b.bytes)}</td>
                  <td className="py-2 text-right text-muted">{fmtRelative(b.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {s3Info?.enabled && (
          <>
            <div className="text-xs uppercase tracking-wide text-muted mb-2 mt-4">
              S3 ({s3Info.bucket}/{s3Info.prefix})
            </div>
            {s3Info.error ? (
              <div className="panel p-3 text-sm bg-red-500/10 border-red-500/30 text-red-300">
                S3 listing failed: {s3Info.error}
              </div>
            ) : s3Info.backups.length === 0 ? (
              <div className="text-muted text-sm">No S3 backups yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-2 font-medium">Key</th>
                    <th className="text-right py-2 font-medium">Size</th>
                    <th className="text-right py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {s3Info.backups.map((b) => (
                    <tr key={b.key} className="border-t border-border/60">
                      <td className="py-2 font-mono text-xs truncate max-w-[420px]">{b.filename}</td>
                      <td className="py-2 text-right tabular-nums">{fmtBytes(b.bytes)}</td>
                      <td className="py-2 text-right text-muted">{fmtRelative(b.lastModified ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="panel p-5">
        <div className="font-medium mb-3">Recent syncs</div>
        {status.length === 0 ? (
          <div className="text-muted text-sm">No syncs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 font-medium">Institution</th>
                <th className="text-right py-2 font-medium">Added</th>
                <th className="text-right py-2 font-medium">Modified</th>
                <th className="text-right py-2 font-medium">Removed</th>
                <th className="text-right py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {status.map((s) => (
                <tr key={s.id} className="border-t border-border/60">
                  <td className="py-2">{s.institution_name ?? s.item_id}</td>
                  <td className="py-2 text-right tabular-nums">{s.added}</td>
                  <td className="py-2 text-right tabular-nums">{s.modified}</td>
                  <td className="py-2 text-right tabular-nums">{s.removed}</td>
                  <td className="py-2 text-right text-muted">
                    {fmtRelative(s.finished_at ?? s.started_at)}
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
