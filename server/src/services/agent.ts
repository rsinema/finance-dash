import { z } from "zod";
import { db } from "../db";
import { CATEGORIES } from "../lib/categories";
import { env } from "../env";
import { isMoonshotConfigured, moonshot } from "./moonshot";

type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: unknown; result?: unknown }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

const TOOLS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: unknown) => unknown;
}> = [
  {
    name: "summarize_by_category",
    description:
      "Total spending grouped by category between a date range. Dates in YYYY-MM-DD. Returns array of { category, total, count }.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date YYYY-MM-DD inclusive" },
        to: { type: "string", description: "ISO date YYYY-MM-DD inclusive" },
      },
      required: ["from", "to"],
    },
    run: (args) => {
      const { from, to } = z
        .object({ from: z.string(), to: z.string() })
        .parse(args);
      return db()
        .query<{ category: string | null; total: number; count: number }, [string, string]>(
          `SELECT category, SUM(amount) as total, COUNT(*) as count
           FROM transactions
           WHERE deleted_at IS NULL AND date >= ? AND date <= ?
           GROUP BY category
           ORDER BY total DESC`,
        )
        .all(from, to);
    },
  },
  {
    name: "compare_periods",
    description:
      "Compare totals for a category (or 'all') between two date ranges. Returns { period_a, period_b, delta }.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...CATEGORIES, "all"] },
        a_from: { type: "string" },
        a_to: { type: "string" },
        b_from: { type: "string" },
        b_to: { type: "string" },
      },
      required: ["category", "a_from", "a_to", "b_from", "b_to"],
    },
    run: (args) => {
      const p = z
        .object({
          category: z.string(),
          a_from: z.string(),
          a_to: z.string(),
          b_from: z.string(),
          b_to: z.string(),
        })
        .parse(args);
      const sumPeriod = (from: string, to: string): number => {
        if (p.category === "all") {
          const r = db()
            .query<{ total: number | null }, [string, string]>(
              `SELECT SUM(amount) as total FROM transactions
               WHERE deleted_at IS NULL AND date >= ? AND date <= ?
               AND category NOT IN ('Income', 'Transfer')`,
            )
            .get(from, to);
          return r?.total ?? 0;
        }
        const r = db()
          .query<{ total: number | null }, [string, string, string]>(
            `SELECT SUM(amount) as total FROM transactions
             WHERE deleted_at IS NULL AND date >= ? AND date <= ? AND category = ?`,
          )
          .get(from, to, p.category);
        return r?.total ?? 0;
      };
      const a = sumPeriod(p.a_from, p.a_to);
      const b = sumPeriod(p.b_from, p.b_to);
      return { period_a: a, period_b: b, delta: b - a };
    },
  },
  {
    name: "query_transactions",
    description:
      "List transactions matching filters (category, date range, search). Limited to 50 rows.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        search: { type: "string", description: "substring match on merchant_name or name" },
      },
    },
    run: (args) => {
      const p = z
        .object({
          category: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          search: z.string().optional(),
        })
        .parse(args);
      const where = ["deleted_at IS NULL"];
      const params: (string | number)[] = [];
      if (p.category) {
        where.push("category = ?");
        params.push(p.category);
      }
      if (p.from) {
        where.push("date >= ?");
        params.push(p.from);
      }
      if (p.to) {
        where.push("date <= ?");
        params.push(p.to);
      }
      if (p.search) {
        where.push("(LOWER(name) LIKE ? OR LOWER(merchant_name) LIKE ?)");
        const term = `%${p.search.toLowerCase()}%`;
        params.push(term, term);
      }
      const sql = `SELECT id, date, name, merchant_name, amount, category, confidence
                   FROM transactions WHERE ${where.join(" AND ")}
                   ORDER BY date DESC LIMIT 50`;
      return db().query(sql).all(...params);
    },
  },
  {
    name: "today",
    description: "Returns today's date as YYYY-MM-DD in the configured timezone.",
    parameters: { type: "object", properties: {} },
    run: () => {
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: env.TZ });
      return { date: fmt.format(new Date()) };
    },
  },
];

const SYSTEM_PROMPT = `You are a finance assistant with read-only access to the user's transactions database.
Use the provided tools to answer questions. Be concise. Always prefer hitting the tools to compute numbers
rather than guessing. When citing money, format as USD with two decimals. The user's spending math excludes
the categories "Income" and "Transfer" (which represent paychecks and internal money movement).`;

export async function runAgent(
  question: string,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  if (!isMoonshotConfigured()) {
    await emit({ type: "error", message: "MOONSHOT_API_KEY not set" });
    return;
  }

  const client = moonshot();
  const tools = TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  type Msg = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const MAX_TURNS = 6;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.chat.completions.create({
      model: env.MOONSHOT_AGENT_MODEL,
      messages: messages as never,
      tools,
      tool_choice: "auto",
    });

    const choice = resp.choices[0];
    const msg = choice?.message;
    if (!msg) {
      await emit({ type: "error", message: "no response from agent" });
      return;
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const answer = msg.content ?? "";
      await emit({ type: "answer", text: answer });
      return;
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const call of toolCalls) {
      const tool = TOOLS.find((t) => t.name === call.function.name);
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool: ${call.function.name}` }),
        });
        continue;
      }
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }
      let result: unknown;
      try {
        result = tool.run(parsedArgs);
      } catch (err) {
        result = { error: (err as Error).message };
      }
      await emit({ type: "tool_call", name: tool.name, args: parsedArgs, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  await emit({ type: "error", message: `agent exceeded ${MAX_TURNS} turns without answering` });
}
