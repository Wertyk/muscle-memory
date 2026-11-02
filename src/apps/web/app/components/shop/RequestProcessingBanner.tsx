import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { JsonValue, Run } from "@muscle-memory/recipe-engine";
import type { RequestProcessing } from "@shared/request-processing";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { runPath } from "@/lib/recipe-runs";

import { Button } from "@/components/ui/button";
import { moneyText } from "@/lib/shop-workspace";
import { ProcessingChip } from "./ProcessingChip";
import { PendingMark, QueryError } from "./WorkspaceParts";

function pendingAmount(input: JsonValue): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const amount = (input as Record<string, JsonValue>).amount;
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) return;
  const { amountMinor, currency } = amount as Record<string, JsonValue>;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) ||
    typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return;
  return moneyText({ amountMinor, currency });
}

export function RequestProcessingBanner({ requestId }: { requestId: string }) {
  const processing = useActionQuery<readonly RequestProcessing[]>("list-request-processing", { requestIds: [requestId] });
  if (processing.isError) return <QueryError error={processing.error} retry={() => void processing.refetch()} />;
  const row = processing.data?.find((item) => item.requestId === requestId);
  if (!row) return null;
  if (row.state !== "with_agent" && row.state !== "awaiting_approval") return <ProcessingRunLink row={row} />;
  return <ProcessingAttention key={`${requestId}:${row.runId}`} row={row} />;
}

function ProcessingRunLink({ row }: { row: RequestProcessing }) {
  const t = useT();
  return <section className="shop-panel mb-5" aria-label={t("shop.processingAttention")}><div className="flex flex-wrap items-center gap-3"><ProcessingChip state={row.state} /><Link to={runPath(row.runId)} className="shop-record-link text-sm underline underline-offset-4">{t("runs.viewRun")}</Link></div></section>;
}

function ProcessingAttention({ row }: { row: RequestProcessing }) {
  const t = useT();
  const client = useQueryClient();
  const run = useActionQuery<Run>("get-recipe-run", { runId: row.runId });
  const busy = useRef(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string>();
  const mutation = useActionMutation<Run, { runId: string; approval: { stepId: string; decision: "approve" | "reject" } }>("resume-recipe-run");
  const current = run.data;
  const step = current ? [...current.steps].reverse().find((item) => item.stepId === current.awaitingApprovalStepId && item.status === "awaiting_approval") : undefined;
  const amount = step ? pendingAmount(step.input) : undefined;

  async function decide(decision: "approve" | "reject") {
    if (!step || busy.current || run.isError || current?.status !== "awaiting_approval") return;
    busy.current = true;
    setSettling(true);
    setError(undefined);
    try {
      await mutation.mutateAsync({ runId: row.runId, approval: { stepId: step.stepId, decision } });
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.approvalFailed"));
      // An error can follow durable progress. Read back every affected action
      // observer before enabling another decision; never blindly retry a gate.
    } finally {
      await client.invalidateQueries({ queryKey: ["action"] }, { cancelRefetch: false });
      setSettling(false);
      busy.current = false;
    }
  }

  return (
    <section className="shop-panel mb-5" aria-label={t("shop.processingAttention")} aria-busy={settling}>
      <div className="flex flex-wrap items-center gap-3">
        <ProcessingChip state={row.state} />
        <Link to={runPath(row.runId)} className="shop-record-link text-sm underline underline-offset-4">{t("runs.viewRun")}</Link>
        {run.isPending ? <span role="status" className="flex items-center gap-2 text-sm"><PendingMark />{t("shop.loadingProcessing")}</span> : current && (
          row.state === "awaiting_approval" ? (
            <>
              <div className="min-w-0 flex-1 text-sm">
                {current.status === "awaiting_approval" && step ? (
                  <>
                    <p className="break-words font-medium">{t("shop.pendingStep", { step: step.stepId, action: step.action ?? step.kind })}</p>
                    {amount ? <p className="mt-1 tabular-nums">{t("shop.pendingAmount", { amount })}</p> : step.action === "issue-refund" && <p className="mt-1">{t("shop.pendingRemainingRefund")}</p>}
                  </>
                ) : <p>{t("shop.approvalChanged")}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={!step || current.status !== "awaiting_approval" || settling || run.isFetching || run.isError} onClick={() => void decide("reject")}>{t("shop.reject")}</Button>
                <Button size="sm" disabled={!step || current.status !== "awaiting_approval" || settling || run.isFetching || run.isError} onClick={() => void decide("approve")}>
                  {settling && <PendingMark />}{t(settling ? "shop.pending" : "shop.approve")}
                </Button>
              </div>
            </>
          ) : row.state === "with_agent" ? (
            <>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{t(current.handoff?.context.to === "human" ? "shop.queuedForHuman" : "shop.queuedForAgent")}</p>
                {typeof current.handoff?.context.note === "string" && <p className="mt-1 break-words text-muted-foreground">{current.handoff.context.note.slice(0, 240)}</p>}
              </div>
              <Button size="sm" variant="outline" disabled={run.isError || run.isFetching} onClick={() => sendToAgentChat({
                message: t("shop.handoffPrompt", { id: row.requestId, runId: row.runId }),
                context: JSON.stringify({ requestId: row.requestId, runId: row.runId, handoffStepId: current.handoff?.context.stepId, target: current.handoff?.context.to }),
                submit: true,
                openSidebar: true,
              })}>{t("shop.openHandoff")}</Button>
            </>
          ) : null
        )}
      </div>
      {run.isError && <div className="mt-3"><QueryError error={run.error} stale={Boolean(current)} retry={() => void run.refetch()} /></div>}
      {error && <p role="alert" className="shop-form-error mt-3">{error} {t("shop.approvalFailed")}</p>}
    </section>
  );
}
