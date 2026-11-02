import { useActionQuery } from "@agent-native/core/client/hooks";
import type { Run } from "@muscle-memory/recipe-engine";
import type { RequestProcessing } from "@shared/request-processing";
import { isRecipeOutcome } from "@/lib/kiln";
import { runDuration, runRequestId } from "@shared/recipe-runs";
import { AgentCostTag } from "./AgentCostTag";
import { CostTag } from "./CostTag";
import { MakerMark } from "./MakerMark";

/** A linked intake run includes extraction; standalone runs use execution usage. */
export function RunSignature({ run, size = "medium", showRecipe = false }: { run: Run; size?: "compact" | "medium" | "large"; showRecipe?: boolean }) {
  const requestId = runRequestId(run.trigger);
  const query = useActionQuery<readonly RequestProcessing[]>("list-request-processing", { requestIds: requestId ? [requestId] : [] }, { enabled: Boolean(requestId) });
  const intake = !query.isError ? query.data?.find(row => row.runId === run.id) : undefined;
  const measured = !requestId || (query.isSuccess && !query.isError);
  const tokens = intake ? intake.totalTokens : measured ? run.tokens.input + run.tokens.output : null;
  const durationMs = intake ? intake.durationMs : measured ? runDuration(run) : null;
  const outcome = { status: run.status, mode: run.mode, recipeName: run.recipe.name, version: run.recipe.version, tokens };
  return <div className="kiln-signature">
    <MakerMark size={size} outcome={outcome} />
    {showRecipe && isRecipeOutcome(outcome) && <span className="kiln-signature-label">Handled by {run.recipe.name} · v{run.recipe.version}</span>}
    {run.status === "handed_off" && requestId ? <AgentCostTag requestId={requestId} showUnknown /> : <span><CostTag tokens={tokens} durationMs={durationMs} />{intake && (tokens !== null || durationMs !== null) && <span className="kiln-cost-scope"> (incl. intake)</span>}</span>}
  </div>;
}
