import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  registerActionChatRenderer,
  type ToolRendererProps,
} from "@agent-native/toolkit/app/chat";
import type { Run } from "@muscle-memory/recipe-engine";
import {
  APPROVAL_CARD_RENDERER,
  RUN_CARD_RENDERER,
  RUN_STATUSES,
} from "@shared/recipe-runs";
import { Link } from "react-router";

import { runPath } from "@/lib/recipe-runs";

import { QueryError } from "../shop/WorkspaceParts";
import { RunSignature } from "../kiln/RunSignature";
import { RunApproval } from "./RunApproval";
import {
  RunLinks,
  RunReason,
  RunStatusChip,
  RunTimeline,
} from "./RunParts";

function SavedRunCard({ snapshot }: { snapshot: Run }) {
  const t = useT();
  // Tool output is historical. Always check the durable checkpoint before decisions.
  const query = useActionQuery<Run>(
    "get-recipe-run",
    { runId: snapshot.id },
    { placeholderData: snapshot },
  );
  const run = query.data ?? snapshot;
  return (
    <article
      className="run-chat-card"
      data-run-card={run.id}
      aria-label={t("runs.details")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RunStatusChip status={run.status} />
        <RunSignature run={run} />
      </div>
      <h3 className="shop-serif mt-3 break-words text-xl">{run.recipe.name}</h3>
      <div className="mt-2">
        <RunLinks run={run} compact />
      </div>
      <RunTimeline run={run} compact />
      <RunReason run={run} />
      {run.status === "awaiting_approval" && <RunApproval runId={run.id} />}
      {query.isError && (
        <QueryError
          error={query.error}
          stale
          retry={() => void query.refetch()}
        />
      )}
      <Link
        className="shop-record-link mt-4 inline-block text-sm underline underline-offset-4"
        to={runPath(run.id)}
      >
        {t("runs.viewRun")} →
      </Link>
    </article>
  );
}
export function RunChatCard({ context }: ToolRendererProps) {
  const result = context.resultJson;
  if (!result || typeof result !== "object" || context.status === "failed")
    return null;
  const run = result as Run;
  if (
    typeof run.id !== "string" ||
    !/^run_[A-Za-z0-9_-]+$/.test(run.id) ||
    !run.recipe ||
    !Array.isArray(run.steps) ||
    !RUN_STATUSES.includes(run.status)
  )
    return null;
  return <SavedRunCard key={run.id} snapshot={run} />;
}

// Root import makes registration available in both the sidebar and full chat.
registerActionChatRenderer({
  id: RUN_CARD_RENDERER,
  renderer: RUN_CARD_RENDERER,
  Component: RunChatCard,
});
registerActionChatRenderer({
  id: APPROVAL_CARD_RENDERER,
  renderer: APPROVAL_CARD_RENDERER,
  Component: RunChatCard,
});
