import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { Run } from "@muscle-memory/recipe-engine";
import { awaitingStep } from "@shared/recipe-runs";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { presentationContext, stepLabel, valueSummary } from "@/lib/recipe-presentation";

import { PendingMark, QueryError } from "../shop/WorkspaceParts";

/** Both surfaces decide the exact saved gate through the shared executor action. */
export function RunApproval({ runId }: { runId: string }) {
  const t = useT();
  const client = useQueryClient();
  const query = useActionQuery<Run>("get-recipe-run", { runId });
  const mutation = useActionMutation<
    Run,
    {
      runId: string;
      approval: { stepId: string; decision: "approve" | "reject" };
    }
  >("resume-recipe-run");
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const step = query.data ? awaitingStep(query.data) : undefined;
  async function decide(decision: "approve" | "reject") {
    if (!step || query.isError || query.isFetching || busy.current) return;
    busy.current = true;
    setSettling(true);
    setError(undefined);
    try {
      await mutation.mutateAsync({
        runId,
        approval: { stepId: step.stepId, decision },
      });
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("runs.approvalFailed"));
    } finally {
      // Failure may follow a committed decision. Read back before re-enabling.
      await client.invalidateQueries(
        { queryKey: ["action"] },
        { cancelRefetch: false },
      );
      busy.current = false;
      setSettling(false);
    }
  }
  if (query.isPending)
    return (
      <p role="status" className="flex gap-2 text-sm">
        <PendingMark />
        {t("runs.approvalLoading")}
      </p>
    );
  if (!step && !error && !query.isError) return null;
  return (
    <section
      className="run-approval"
      aria-label={t("runs.gate")}
      aria-busy={settling}
    >
      {step ? (
        <>
          <h3 className="font-semibold">{t("runs.approvalTitle")}</h3>
          <p className="mt-2 break-words text-sm">
            {stepLabel(step, t)} · {valueSummary(step.input, presentationContext(query.data))}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("runs.approvalHint")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={settling || query.isFetching || query.isError}
              onClick={() => void decide("approve")}
            >
              {settling && <PendingMark />}
              {t(settling ? "shop.pending" : "shop.approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={settling || query.isFetching || query.isError}
              onClick={() => void decide("reject")}
            >
              {t("shop.reject")}
            </Button>
          </div>
        </>
      ) : (
        !query.isError && <p className="text-sm">{t("runs.approvalChanged")}</p>
      )}
      {query.isError && (
        <QueryError
          error={query.error}
          stale={Boolean(query.data)}
          retry={() => void query.refetch()}
        />
      )}
      {error && (
        <p className="shop-form-error mt-3" role="alert">
          {error} {t("runs.approvalFailed")}
        </p>
      )}
    </section>
  );
}
