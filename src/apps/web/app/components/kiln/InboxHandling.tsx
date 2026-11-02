import { useT } from "@agent-native/core/client/i18n";
import type { RequestProcessing } from "@shared/request-processing";
import { inboxOutcome } from "@/lib/kiln";
import { ProcessingChip } from "../shop/ProcessingChip";
import { AgentCostTag } from "./AgentCostTag";
import { CostTag } from "./CostTag";
import { MakerMark } from "./MakerMark";

export function InboxHandling({ row }: { row: RequestProcessing }) {
  const t = useT();
  const kind = inboxOutcome(row);
  if (kind === "recipe" && row.recipe) return <div className="kiln-inbox-handling" data-handler="recipe" data-processing={row.state ?? "processing"}>
    <span className="sr-only">{t(`shop.processingStates.${row.state ?? "processing"}`)}</span>
    <div className="kiln-handling-recipe"><MakerMark outcome={{ status: row.runStatus, mode: row.mode, recipeName: row.recipe.name, version: row.recipe.version, tokens: row.totalTokens }} />
      <span className="kiln-recipe-name" title={row.recipe.name}>{row.recipe.name}</span>
    </div>
    <CostTag tokens={row.totalTokens} durationMs={row.durationMs} />
  </div>;
  return <div className="kiln-inbox-handling" data-handler={kind === "agent" ? "agent" : undefined}>
    <ProcessingChip state={kind === "agent" ? "with_agent" : row.state} />
    {kind === "agent" && <AgentCostTag requestId={row.requestId} />}
  </div>;
}
