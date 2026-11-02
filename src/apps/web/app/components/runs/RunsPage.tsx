import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { RUN_STATUSES, type RunSummary } from "@shared/recipe-runs";
import { Link, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { durationText, runPath } from "@/lib/recipe-runs";
import { CostTag } from "../kiln/CostTag";
import { valueSummary } from "@/lib/recipe-presentation";
import { dateText } from "@/lib/shop-workspace";

import {
  EmptyState,
  PendingMark,
  QueryError,
  ShopMasthead,
} from "../shop/WorkspaceParts";
import { RunsLoading, RunStatusChip } from "./RunParts";

export function RunsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const status = RUN_STATUSES.find((value) => value === params.get("status"));
  const mode = ["execute", "dry-run"].find(
    (value) => value === params.get("mode"),
  );
  const requestId = params.get("requestId") ?? "";
  const recipeId = params.get("recipeId") ?? "";
  // ID filters are exact; incomplete IDs stay local until they can be sent.
  const query = useActionQuery<readonly RunSummary[]>(
    "list-recipe-runs",
    {
      ...(status ? { status } : {}),
      ...(mode ? { mode } : {}),
      ...(requestId &&
      /^req_[A-Za-z0-9_-]+$/.test(requestId) &&
      requestId.length <= 31
        ? { requestId }
        : {}),
      ...(recipeId && recipeId.length <= 31 ? { recipeId } : {}),
    },
    { placeholderData: (previous) => previous },
  );
  function filter(key: string, value: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (!value || value === "all") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }
  const rows = (query.data ?? []).filter(
    (row) =>
      (!requestId || row.requestId?.includes(requestId)) &&
      (!recipeId || row.recipeId.includes(recipeId)),
  );
  const filtered = Boolean(status || mode || requestId || recipeId);
  return (
    <div className="shop-page">
      <ShopMasthead />
      <header className="shop-page-heading">
        <h1 className="shop-serif">{t("runs.title")}</h1>
        {query.isFetching && (
          <span role="status">
            <PendingMark />
          </span>
        )}
      </header>
      <div className="shop-filters">
        <Select
          value={status ?? "all"}
          onValueChange={(value) => filter("status", value)}
        >
          <SelectTrigger
            aria-label={t("runs.statusFilter")}
            className="w-full sm:w-48"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("runs.allStatuses")}</SelectItem>
            {RUN_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`runs.states.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={mode ?? "all"}
          onValueChange={(value) => filter("mode", value)}
        >
          <SelectTrigger
            aria-label={t("runs.modeFilter")}
            className="w-full sm:w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("runs.allModes")}</SelectItem>
            {["execute", "dry-run"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`runs.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t("runs.requestFilter")}
          placeholder={t("runs.requestFilter")}
          value={requestId}
          onChange={(event) => filter("requestId", event.target.value)}
          className="w-full sm:w-36"
        />
        <Input
          aria-label={t("runs.recipeFilter")}
          placeholder={t("runs.recipeFilter")}
          value={recipeId}
          onChange={(event) => filter("recipeId", event.target.value)}
          className="w-full sm:w-44"
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setParams({})}>
            {t("shop.clearFilters")}
          </Button>
        )}
      </div>
      {query.isError && (
        <QueryError
          error={query.error}
          stale={Boolean(query.data)}
          retry={() => void query.refetch()}
        />
      )}
      {query.isPending ? (
        <RunsLoading />
      ) : !rows.length && !query.isError ? (
        <EmptyState title={t(filtered ? "runs.noMatches" : "runs.noRuns")} />
      ) : (
        rows.length > 0 && (
          <div className="kiln-run-list">
            <div className="kiln-run-head" aria-hidden="true">
              <span>{t("runs.request")}</span><span>{t("runs.recipe")}</span><span>{t("shop.status")}</span><span>{t("runs.tokens")} · {t("runs.duration")}</span>
            </div>
            <ul aria-label={t("runs.title")}>
              {rows.map(run => <li key={run.id}>
                <Link className="kiln-run-row" to={runPath(run.id)}>
                  <span><strong>{valueSummary(run.requestSubject ?? run.id)}</strong>
                    <span className="kiln-run-meta kiln-data">{run.requestId ?? t("runs.noRequest")}</span>
                    <time className="kiln-run-meta" dateTime={new Date(run.createdAt).toISOString()}>{dateText(new Date(run.createdAt).toISOString())}</time>
                    <span className="kiln-run-meta underline underline-offset-4">{t("runs.viewRun")} →</span>
                  </span>
                  <span><strong>{run.recipeName}</strong><span className="kiln-run-meta">{t("runs.version", { version: run.version })}</span>
                    <span className="kiln-mode" data-mode={run.mode}>{t(`runs.${run.mode}`)}</span>
                  </span>
                  <span><RunStatusChip status={run.status} /></span>
                  <span title={`${t("runs.tokenScope")} ${t("runs.durationScope")}`}>
                    <CostTag tokens={run.tokens.input + run.tokens.output} durationMs={run.durationMs} handler={run.status === "completed" && run.mode === "execute" ? "recipe" : "neutral"} />
                    <span className="sr-only">{durationText(run.durationMs)}</span>
                  </span>
                </Link>
              </li>)}
            </ul>
          </div>
        )
      )}
    </div>
  );
}
