import { useState } from "react";
import { api } from "../lib/api";

type Event =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: unknown; result?: unknown }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

export function Ask() {
  const [question, setQuestion] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setEvents([]);
    try {
      const resp = await api.askAgent(question);
      if (!resp.body) throw new Error("no response stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as Event;
            setEvents((prev) => [...prev, evt]);
          } catch {
            /* swallow malformed line */
          }
        }
      }
    } catch (err) {
      setEvents((prev) => [...prev, { type: "error", message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const answer = events.find((e) => e.type === "answer") as { text: string } | undefined;
  const errors = events.filter((e): e is { type: "error"; message: string } => e.type === "error");
  const toolCalls = events.filter(
    (e): e is { type: "tool_call"; name: string; args: unknown; result?: unknown } =>
      e.type === "tool_call",
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Ask</h1>
        <div className="text-sm text-muted">
          Natural-language questions over your transactions.
        </div>
      </div>

      <form onSubmit={ask} className="flex gap-2">
        <input
          className="input flex-1"
          placeholder='e.g. "How much did I spend on dining out last month vs. the previous one?"'
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <button className="btn-primary" disabled={busy}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>

      {errors.length > 0 && (
        <div className="panel p-3 text-sm bg-red-500/10 border-red-500/30 text-red-300">
          {errors.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}

      {answer && (
        <div className="panel p-5 whitespace-pre-wrap">{answer.text}</div>
      )}

      {toolCalls.length > 0 && (
        <div className="panel p-4 text-xs">
          <button
            className="text-muted hover:text-text"
            onClick={() => setShowTrace((v) => !v)}
          >
            {showTrace ? "▼" : "▶"} {toolCalls.length} tool call
            {toolCalls.length === 1 ? "" : "s"}
          </button>
          {showTrace && (
            <div className="mt-3 space-y-3 font-mono">
              {toolCalls.map((t, i) => (
                <div key={i}>
                  <div className="text-accent">{t.name}({JSON.stringify(t.args)})</div>
                  <pre className="text-muted whitespace-pre-wrap">
                    {JSON.stringify(t.result, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
