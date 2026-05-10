import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Products } from "plaid";
import { plaid, plaidCountries, plaidProducts } from "../services/plaid";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import {
  deleteItem,
  getItem,
  listItems,
  upsertAccount,
  upsertItem,
} from "../db/queries";
import { syncItem } from "../services/sync";
import { env } from "../env";

export const plaidRouter = new Hono();

plaidRouter.get("/status", (c) => {
  return c.json({
    configured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
    env: env.PLAID_ENV,
  });
});

plaidRouter.post("/link-token", async (c) => {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return c.json(
      { error: "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in .env, then restart the server." },
      503,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const accessTokenForUpdate: string | undefined = body?.itemId
    ? await (async () => {
        const item = getItem(body.itemId as string);
        if (!item) return undefined;
        return decryptSecret(item.access_token_enc);
      })()
    : undefined;

  const resp = await plaid().linkTokenCreate({
    user: { client_user_id: "self" },
    client_name: "Finance Tracker",
    products: accessTokenForUpdate ? [] : (plaidProducts() as Products[]),
    country_codes: plaidCountries(),
    language: "en",
    access_token: accessTokenForUpdate,
    redirect_uri: env.PLAID_REDIRECT_URI || undefined,
  });

  return c.json({ link_token: resp.data.link_token, expiration: resp.data.expiration });
});

plaidRouter.post(
  "/exchange",
  zValidator(
    "json",
    z.object({
      public_token: z.string().min(1),
    }),
  ),
  async (c) => {
    const { public_token } = c.req.valid("json");

    const exchange = await plaid().itemPublicTokenExchange({ public_token });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    // Look up institution metadata.
    let institutionId: string | null = null;
    let institutionName: string | null = null;
    try {
      const itemResp = await plaid().itemGet({ access_token: accessToken });
      institutionId = itemResp.data.item.institution_id ?? null;
      if (institutionId) {
        const inst = await plaid().institutionsGetById({
          institution_id: institutionId,
          country_codes: plaidCountries(),
        });
        institutionName = inst.data.institution.name ?? null;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[plaid] institution lookup failed:", (err as Error).message);
    }

    const accessTokenEnc = await encryptSecret(accessToken);
    upsertItem({
      item_id: itemId,
      access_token_enc: accessTokenEnc,
      institution_id: institutionId,
      institution_name: institutionName,
    });

    // Pull initial accounts immediately (so the UI reflects them before first sync completes).
    try {
      const accountsResp = await plaid().accountsGet({ access_token: accessToken });
      for (const acct of accountsResp.data.accounts) {
        upsertAccount({
          id: acct.account_id,
          item_id: itemId,
          name: acct.name,
          official_name: acct.official_name ?? null,
          type: acct.type ?? null,
          subtype: acct.subtype ?? null,
          mask: acct.mask ?? null,
          currency: acct.balances?.iso_currency_code ?? null,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[plaid] initial accounts fetch failed:", (err as Error).message);
    }

    // Kick off first sync in the background.
    syncItem(itemId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[plaid] initial sync failed:", err);
    });

    return c.json({ item_id: itemId, institution_name: institutionName });
  },
);

plaidRouter.get("/items", (c) => {
  const items = listItems();
  return c.json({
    items: items.map((i) => ({
      item_id: i.item_id,
      institution_id: i.institution_id,
      institution_name: i.institution_name,
      cursor: i.cursor ? "set" : null,
      last_synced_at: i.last_synced_at,
      created_at: i.created_at,
    })),
  });
});

plaidRouter.delete("/items/:itemId", async (c) => {
  const itemId = c.req.param("itemId");
  const item = getItem(itemId);
  if (!item) return c.json({ error: "not_found" }, 404);
  try {
    const accessToken = await decryptSecret(item.access_token_enc);
    await plaid().itemRemove({ access_token: accessToken });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[plaid] item/remove failed (continuing with local delete):", (err as Error).message);
  }
  deleteItem(itemId);
  return c.json({ ok: true });
});
