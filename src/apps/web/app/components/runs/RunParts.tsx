import { useT } from "@agent-native/core/client/i18n";
import type {
  JsonValue,
  Run,
  Step,
  StepRun,
} from "@muscle-memory/recipe-engine";
import { runDuration, runRequestId } from "@shared/recipe-runs";
import { IconCheck, IconClock, IconX } from "@tabler/icons-react";
import { Link } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import {
  durationText,
  recipeVersionPath,
  valueSummary,
} from "@/lib/recipe-runs";
import { dateText, requestPath } from "@/lib/shop-workspace";

import { PendingMark } from "../shop/WorkspaceParts";

type Translate = ReturnType<typeof useT>;
export function stepLabel(
  step: Pick<StepRun, "kind" | "action">,
  t: Translate,
) {
  if (step.action) {
    const key = `shop.teachActions.${step.action}`;
    const label = t(key);
    return label === key ? step.action.replace(/-/g, " ") : label;
  }
  return t(`runs.${step.kind}`);
}
export function RunStatusChip({
  status,
}: {
  status: Run["status"] | StepRun["status"] | "pending";
}) {
  const t = useT();
  return (
    <span className="run-status" data-status={status}>
      <span aria-hidden="true" />
      {t(`runs.states.${status}`)}
    </span>
  );
}
export function TokenCount({ tokens }: { tokens: Run["tokens"] }) {
  const t = useT();
  const count = tokens.input + tokens.output;
  return (
    <span
      className={count === 0 ? "run-zero-tokens" : "tabular-nums"}
      title={t("runs.tokenDetail", {
        input: tokens.input,
        output: tokens.output,
      })}
    >
      {t(count === 0 ? "runs.zeroTokens" : "runs.tokenCount", { count })}
    </span>
  );
}
export function RunLinks({
  run,
  compact = false,
}: {
  run: Run;
  compact?: boolean;
}) {
  const t = useT();
  const requestId = runRequestId(run.trigger);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {requestId ? (
        <Link className="shop-record-link" to={requestPath(requestId)}>
          {requestId}
        </Link>
      ) : (
        <span className="text-muted-foreground">{t("runs.noRequest")}</span>
      )}
      <Link
        className="shop-record-link break-words"
        to={recipeVersionPath(run.recipe.recipeId, run.recipe.id)}
      >
        {!compact && `${run.recipe.name} · `}
        {t("runs.version", { version: run.recipe.version })}
      </Link>
      {run.mode === "dry-run" && (
        <span className="shop-tag">{t("runs.dry-run")}</span>
      )}
    </div>
  );
}
export function RunsLoading() {
  const t = useT();
  return (
    <div className="space-y-3" role="status" aria-label={t("runs.loading")}>
      <span className="sr-only">{t("runs.loading")}</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}
export function RunMetrics({ run }: { run: Run }) {
  const t = useT();
  return (
    <dl className="run-metrics">
      <div>
        <dt>{t("runs.started")}</dt>
        <dd>{dateText(new Date(run.createdAt).toISOString())}</dd>
      </div>
      <div title={t("runs.durationScope")}>
        <dt>{t("runs.duration")}</dt>
        <dd>{durationText(runDuration(run))}</dd>
      </div>
      <div title={t("runs.tokenScope")}>
        <dt>{t("runs.tokens")}</dt>
        <dd>
          <TokenCount tokens={run.tokens} />
        </dd>
      </div>
    </dl>
  );
}
export function RunReason({ run }: { run: Run }) {
  const t = useT();
  if (run.failure || run.handoff)
    return (
      <div className="space-y-3">
        {run.failure && (
          <div className="shop-error" role="status">
            <div>
              <p className="font-medium">{t("runs.failure")}</p>
              <p className="mt-1 break-words text-sm">
                {run.failure.stepId}: {run.failure.message}
              </p>
            </div>
          </div>
        )}
        {run.handoff && (
          <div className="run-notice">
            <p className="font-medium">
              {t(
                run.handoff.status === "pending"
                  ? "runs.deliveryPending"
                  : run.handoff.context.to === "human"
                    ? "runs.queuedHuman"
                    : "runs.queuedAgent",
              )}
            </p>
            <p className="mt-1 break-words text-sm">
              {valueSummary(run.handoff.context.note)}
            </p>
            {run.handoff.error && (
              <p className="mt-1 text-sm">{run.handoff.error}</p>
            )}
          </div>
        )}
      </div>
    );
  if (run.status === "aborted")
    return <p className="run-notice">{t("runs.aborted")}</p>;
  return null;
}
function StepMark({ step }: { step: StepRun }) {
  if (step.status === "completed")
    return <IconCheck aria-hidden="true" className="size-4" />;
  if (step.status === "failed" || step.status === "rejected")
    return <IconX aria-hidden="true" className="size-4" />;
  if (step.status === "running") return <PendingMark />;
  return <IconClock aria-hidden="true" className="size-4" />;
}
export function JsonEvidence({
  title,
  value,
}: {
  title: string;
  value: JsonValue;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">
        {title}
      </h4>
      <pre className="run-json">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
export function RunTimeline({
  run,
  compact = false,
}: {
  run: Run;
  compact?: boolean;
}) {
  const t = useT();
  const definitions = new Map<string, Step>();
  const visit = (steps: readonly Step[]) =>
    steps.forEach((step) => {
      definitions.set(step.id, step);
      if (step.kind === "branch") {
        visit(step.then);
        visit(step.else);
      }
    });
  visit(run.recipe.steps);
  const pending = run.pendingStepIds.filter(
    (id) => !run.steps.some((step) => step.stepId === id),
  );
  return (
    <ol
      className={compact ? "run-timeline run-timeline-compact" : "run-timeline"}
      aria-label={t("runs.timeline")}
    >
      {run.steps.map((step, index) => (
        <li key={`${step.stepId}:${step.attempt}`} data-status={step.status}>
          <span className="run-step-mark">
            <StepMark step={step} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="min-w-0 break-words font-medium">
                <span className="me-2 text-xs tabular-nums text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {stepLabel(step, t)}
              </h3>
              {!compact && <RunStatusChip status={step.status} />}
            </div>
            {!compact && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{step.stepId}</span>
                  <span>{durationText(step.durationMs)}</span>
                  <TokenCount tokens={step.tokens} />
                  {step.attempt > 1 && (
                    <span>{t("runs.attempt", { attempt: step.attempt })}</span>
                  )}
                  {step.approvalRequired && (
                    <span className="run-gate">
                      {t(
                        step.status === "rejected"
                          ? "runs.gateRejected"
                          : run.approvedStepIds.includes(step.stepId)
                            ? "runs.gateApproved"
                            : "runs.gate",
                      )}
                    </span>
                  )}
                </div>
                <dl className="run-step-values">
                  <div>
                    <dt>{t("runs.input")}</dt>
                    <dd>
                      {step.input === null
                        ? t("runs.noInput")
                        : valueSummary(step.input)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("runs.output")}</dt>
                    <dd>
                      {step.output === null
                        ? t("runs.noOutput")
                        : valueSummary(step.output)}
                    </dd>
                  </div>
                </dl>
                {step.error && (
                  <p className="shop-form-error mt-3">{step.error}</p>
                )}
                {step.blockedBy.length > 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("runs.blockedBy", { steps: step.blockedBy.join(", ") })}
                  </p>
                )}
                <details className="run-evidence">
                  <summary>{t("runs.inspect")}</summary>
                  <div className="mt-3 grid gap-4 lg:grid-cols-2">
                    <JsonEvidence title={t("runs.input")} value={step.input} />
                    <JsonEvidence
                      title={t("runs.output")}
                      value={step.output}
                    />
                  </div>
                </details>
              </>
            )}
            {compact && step.status !== "completed" && (
              <span className="text-xs text-muted-foreground">
                {t(`runs.states.${step.status}`)}
              </span>
            )}
          </div>
        </li>
      ))}
      {!compact &&
        pending.map((id) => {
          const step = definitions.get(id);
          return (
            <li key={`pending:${id}`} data-status="pending">
              <span className="run-step-mark">
                <IconClock className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="font-medium">
                  {step
                    ? stepLabel(
                        {
                          kind: step.kind,
                          action: step.kind === "action" ? step.action : null,
                        },
                        t,
                      )
                    : id}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("runs.notExecuted")}
                </p>
              </div>
            </li>
          );
        })}
    </ol>
  );
}
