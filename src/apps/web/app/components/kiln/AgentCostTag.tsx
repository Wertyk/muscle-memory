import { useActionQuery } from "@agent-native/core/client/hooks";
import type { HandlingStats } from "@muscle-memory/shop-domain";
import { CostTag } from "./CostTag";

/** Reuse the dashboard's scoped attribution; a queued handoff has no agent cost. */
export function AgentCostTag({ requestId, showUnknown = false }: { requestId: string; showUnknown?: boolean }) {
  const query = useActionQuery<HandlingStats>("get-handling-stats", {});
  const sample = !query.isError ? query.data?.samples.find(row => row.requestId === requestId && row.handler === "agent") : undefined;
  if (sample?.tokens == null && !showUnknown) return null;
  return <CostTag handler="agent" tokens={sample?.tokens ?? null} durationMs={sample?.durationMs ?? null} />;
}
