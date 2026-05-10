import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import { env, plaidCountriesArray, plaidProductsArray } from "../env";

let _client: PlaidApi | null = null;

export function plaid(): PlaidApi {
  if (_client) return _client;
  const basePath = PlaidEnvironments[env.PLAID_ENV];
  if (!basePath) {
    throw new Error(`Unknown PLAID_ENV: ${env.PLAID_ENV}`);
  }
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are required");
  }
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
        "PLAID-SECRET": env.PLAID_SECRET,
      },
    },
  });
  _client = new PlaidApi(config);
  return _client;
}

export function plaidProducts(): Products[] {
  return plaidProductsArray().map((p) => p as Products);
}

export function plaidCountries(): CountryCode[] {
  return plaidCountriesArray().map((c) => c as CountryCode);
}
