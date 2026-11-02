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
import { durationText, recipeVersionPath, runPath } from "@/lib/recipe-runs";
import { dateText, requestPath } from "@/lib/shop-workspace";

import {
  EmptyState,
  PendingMark,
  QueryError,
  ShopMasthead,
} from "../shop/WorkspaceParts";
import { RunsLoading, RunStatusChip, TokenCount } from "./RunParts";

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
          <div className="run-table-wrap">
            <table className="run-table">
              <thead>
                <tr>
                  {[
                    "request",
                    "recipe",
                    "status",
                    "started",
                    "duration",
                    "tokens",
                  ].map((key) => (
                    <th key={key} scope="col">
                      {t(key === "status" ? "shop.status" : `runs.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link
                        className="shop-record-link font-medium"
                        to={runPath(run.id)}
                      >
                        {run.requestSubject ?? run.id}
                      </Link>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {run.requestId ? (
                          <Link
                            className="shop-record-link"
                            to={requestPath(run.requestId)}
                          >
                            {run.requestId}
                          </Link>
                        ) : (
                          t("runs.noRequest")
                        )}
                      </div>
                      <Link
                        to={runPath(run.id)}
                        className="mt-2 inline-block text-xs underline underline-offset-4"
                      >
                        {t("runs.viewRun")}
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="shop-record-link"
                        to={recipeVersionPath(
                          run.recipeId,
                          run.recipeVersionId,
                        )}
                      >
                        {run.recipeName}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("runs.version", { version: run.version })}
                        {run.mode === "dry-run" && ` · ${t("runs.dry-run")}`}
                      </p>
                    </td>
                    <td>
                      <RunStatusChip status={run.status} />
                    </td>
                    <td className="tabular-nums">
                      {dateText(new Date(run.createdAt).toISOString())}
                    </td>
                    <td
                      title={t("runs.durationScope")}
                      className="whitespace-nowrap tabular-nums"
                    >
                      {durationText(run.durationMs)}
                    </td>
                    <td title={t("runs.tokenScope")}>
                      <TokenCount tokens={run.tokens} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
