import { formatDuration, formatTokens } from "../shop/dashboard-format";

export function CostTag({ tokens, durationMs, handler = "recipe" }: {
  tokens: number | null;
  durationMs?: number | null;
  handler?: "recipe" | "agent" | "neutral";
}) {
  return <span className="kiln-cost" data-handler={handler} title={tokens === null ? "Token usage unmeasured" : `${tokens.toLocaleString("en-US")} LLM tokens`}>
    {tokens === null ? "Tokens unmeasured" : `${formatTokens(tokens, "en-US")} tokens`}
    {durationMs !== undefined && durationMs !== null && ` · ${formatDuration(durationMs, "en-US")}`}
  </span>;
}
