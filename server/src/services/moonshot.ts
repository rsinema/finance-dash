import OpenAI from "openai";
import { env } from "../env";

let _client: OpenAI | null = null;

export function moonshot(): OpenAI {
  if (_client) return _client;
  if (!env.MOONSHOT_API_KEY) {
    throw new Error("MOONSHOT_API_KEY is required");
  }
  _client = new OpenAI({
    apiKey: env.MOONSHOT_API_KEY,
    baseURL: env.MOONSHOT_BASE_URL,
  });
  return _client;
}

export function isMoonshotConfigured(): boolean {
  return Boolean(env.MOONSHOT_API_KEY);
}
