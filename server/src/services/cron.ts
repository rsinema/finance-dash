import cron from "node-cron";
import { env } from "../env";
import { syncAllItems } from "./sync";
import { backupNow } from "./backup";

let started = false;

export function startCron(): void {
  if (started) return;

  if (env.SYNC_ENABLED) {
    if (!cron.validate(env.SYNC_CRON)) {
      // eslint-disable-next-line no-console
      console.warn(`[cron] invalid SYNC_CRON expression: ${env.SYNC_CRON}; skipping sync`);
    } else {
      cron.schedule(
        env.SYNC_CRON,
        async () => {
          // eslint-disable-next-line no-console
          console.log(`[cron] running scheduled sync at ${new Date().toISOString()}`);
          try {
            const results = await syncAllItems();
            const totals = results.reduce(
              (a, r) => ({
                added: a.added + r.added,
                modified: a.modified + r.modified,
                removed: a.removed + r.removed,
              }),
              { added: 0, modified: 0, removed: 0 },
            );
            // eslint-disable-next-line no-console
            console.log(`[cron] sync complete: ${JSON.stringify(totals)}`);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[cron] sync failed:", (err as Error).message);
          }
        },
        { timezone: env.TZ },
      );
      // eslint-disable-next-line no-console
      console.log(`[cron] sync scheduled '${env.SYNC_CRON}' (tz=${env.TZ})`);
    }
  }

  if (env.BACKUP_ENABLED) {
    if (!cron.validate(env.BACKUP_CRON)) {
      // eslint-disable-next-line no-console
      console.warn(`[cron] invalid BACKUP_CRON expression: ${env.BACKUP_CRON}; skipping backup`);
    } else {
      cron.schedule(
        env.BACKUP_CRON,
        async () => {
          try {
            const result = await backupNow();
            // eslint-disable-next-line no-console
            console.log(
              `[cron] backup wrote ${result.path} (${result.bytes} bytes, pruned ${result.pruned})` +
                (result.s3
                  ? result.s3.error
                    ? ` — S3 FAILED: ${result.s3.error}`
                    : ` — S3 uploaded ${result.s3.key} (pruned ${result.s3.pruned})`
                  : ""),
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[cron] backup failed:", (err as Error).message);
          }
        },
        { timezone: env.TZ },
      );
      // eslint-disable-next-line no-console
      console.log(
        `[cron] backup scheduled '${env.BACKUP_CRON}' (tz=${env.TZ}, retain=${env.BACKUP_RETAIN})`,
      );
    }
  }

  started = true;
}
