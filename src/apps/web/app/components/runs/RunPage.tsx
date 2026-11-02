import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { JsonValue, Run } from "@muscle-memory/recipe-engine";
import type { Request } from "@muscle-memory/shop-domain";
import { runRequestId } from "@shared/recipe-runs";
import { Link, useParams } from "react-router";
import { requestPath } from "@/lib/shop-workspace";
import { fieldLabel, isObject, valueSummary } from "@/lib/recipe-presentation";

import { QueryError, ShopMasthead } from "../shop/WorkspaceParts";
import { RunApproval } from "./RunApproval";
import {
  JsonEvidence,
  RunLinks,
  RunMetrics,
  RunReason,
  RunsLoading,
  RunStatusChip,
  RunTimeline,
} from "./RunParts";

export function RunPage() {
  const t = useT();
  const { runId = "" } = useParams();
  const query = useActionQuery<Run>("get-recipe-run", { runId });
  const requestId = query.data ? runRequestId(query.data.trigger) : null;
  const request = useActionQuery<Request>("get-request", { requestId }, { enabled: Boolean(requestId) });
  if (query.isPending)
    return (
      <div className="shop-page">
        <ShopMasthead />
        <RunsLoading />
      </div>
    );
  const run = query.data;
  return (
    <div className="shop-page run-page">
      <ShopMasthead />
      <Link to="/runs" className="shop-record-link text-sm">
        ← {t("runs.back")}
      </Link>
      {query.isError && (
        <div className="mt-5">
          <QueryError
            error={query.error}
            stale={Boolean(run)}
            retry={() => void query.refetch()}
          />
        </div>
      )}
      {run && (
        <>
          <header className="shop-page-heading mt-6">
            <h1 className="shop-serif break-words">{requestId ? <Link className="shop-record-link" to={requestPath(requestId)}>
              {valueSummary(request.data?.subject ?? (isObject(run.trigger) && typeof run.trigger.subject === "string" ? run.trigger.subject : fieldLabel("request")))} · {requestId}
            </Link> : t("runs.details")}</h1>
            <RunStatusChip status={run.status} />
          </header>
          <RunLinks run={run} showRequest={false} />
          <RunMetrics run={run} />
          <div className="mb-6 space-y-4">
            <RunApproval runId={run.id} />
            <RunReason run={run} />
          </div>
          <section
            className="run-timeline-panel"
            aria-labelledby="run-timeline-title"
          >
            <h2 id="run-timeline-title" className="shop-serif mb-7 text-2xl">
              {t("runs.timeline")}
            </h2>
            <RunTimeline run={run} />
          </section>
          <details className="run-evidence mt-7">
            <summary>
              {t("runs.details")} · {run.id}
            </summary>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <JsonEvidence title={t("runs.trigger")} value={run.trigger} />
              <JsonEvidence
                title={t("runs.snapshot")}
                value={run.recipe as unknown as JsonValue}
              />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
