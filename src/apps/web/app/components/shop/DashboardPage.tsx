import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type {
  HandlingCost,
  HandlingSample,
  HandlingStats,
} from "@muscle-memory/shop-domain";
import { IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dateText, requestPath } from "@/lib/shop-workspace";

import { formatDuration, formatTokens } from "./dashboard-format";
import { formatShare } from "./dashboard-metrics";
import { DashboardHero } from "./DashboardHero";
import { MemoryCurve } from "./MemoryCurve";
import { MakerMark } from "../kiln/MakerMark";
import { QueryError, ShopMasthead } from "./WorkspaceParts";

import "./dashboard.css";

interface Breakdown {
  intake: number | null;
  run: number | null;
  total: number | null;
  agent?: number | null;
  handler?: HandlingSample["handler"];
}
function breakdownText(
  { intake, run, total, agent = null, handler }: Breakdown,
  t: ReturnType<typeof useT>,
  compact = true,
) {
  const value = (tokens: number | null) =>
    tokens === null ? t("dashboard.unknownValue") : formatTokens(tokens);
  if (handler === "agent")
    return t("dashboard.agentBreakdown", {
      agent: value(agent),
      intake: value(intake),
      run: value(run),
    });
  return compact && run === 0 && total !== null && total > 0 && intake === total
    ? t("dashboard.allIntake", { run: value(run) })
    : t("dashboard.breakdown", { intake: value(intake), run: value(run) });
}
function TokenBreakdown(props: Breakdown) {
  return <>{breakdownText(props, useT())}</>;
}

function SampleCount({ cost }: { cost: HandlingCost }) {
  const t = useT();
  return (
    <span className="dashboard-sample-count">
      {cost.tokenSamples === cost.timeSamples
        ? t("dashboard.sampleCount", { count: cost.tokenSamples })
        : t("dashboard.separateCounts", {
            tokens: cost.tokenSamples,
            time: cost.timeSamples,
          })}
    </span>
  );
}

function CostValue({ cost }: { cost: HandlingCost }) {
  const t = useT();
  return (
    <>
      {cost.meanTokens === null && cost.meanDurationMs === null
        ? t("dashboard.unknown")
        : cost.meanTokens === null
          ? t("dashboard.partialTime", {
              duration: formatDuration(cost.meanDurationMs!),
            })
          : cost.meanDurationMs === null
            ? t("dashboard.partialCost", {
                tokens: formatTokens(cost.meanTokens),
              })
            : t("dashboard.meanCost", {
                tokens: formatTokens(cost.meanTokens),
                duration: formatDuration(cost.meanDurationMs),
              })}
    </>
  );
}

function CostCell({
  cost,
  recipe = false,
}: {
  cost: HandlingCost;
  recipe?: boolean;
}) {
  const t = useT();
  if (!cost.tokenSamples && !cost.timeSamples)
    return (
      <td className="dashboard-no-samples">{t("dashboard.noMeasured")}</td>
    );
  return (
    <td>
      <div className="dashboard-cost">
        <CostValue cost={cost} />
      </div>
      <SampleCount cost={cost} />
      {recipe &&
        cost.meanTokens !== null &&
        cost.meanTokens > 0 &&
        cost.meanRunTokens === 0 &&
        cost.meanIntakeTokens === cost.meanTokens &&
        cost.breakdownSamples === cost.tokenSamples && (
          <p className="dashboard-sample-count">
            {t("dashboard.allIntake", { run: formatTokens(0) })}
          </p>
        )}
    </td>
  );
}

export function DashboardPage() {
  const t = useT();
  const [chartBoundary, setChartBoundary] = useState<HTMLElement | null>(null);
  const query = useActionQuery<HandlingStats>(
    "get-handling-stats",
    {},
    { placeholderData: (previous) => previous },
  );
  const data = query.data;
  if (query.isPending)
    return (
      <div
        className="shop-page dashboard-page"
        role="status"
        aria-label={t("dashboard.loading")}
      >
        <ShopMasthead />
        <Skeleton className="h-16 w-2/3 mb-8" />
        <Skeleton className="h-28 w-full mb-8" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (!data)
    return (
      <div className="shop-page">
        <ShopMasthead />
        <QueryError error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <div className="shop-page dashboard-page">
      <ShopMasthead>
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          aria-label={t("dashboard.refresh")}
        >
          <IconRefresh
            className={`size-4 ${query.isFetching ? "motion-safe:animate-spin" : ""}`}
          />
        </Button>
      </ShopMasthead>
      {query.isError && (
        <QueryError
          error={query.error}
          stale
          retry={() => void query.refetch()}
        />
      )}
      <header className="dashboard-heading">
        <h1 className="shop-serif">{t("dashboard.title")}</h1>
      </header>
      <DashboardHero overall={data.overall} />
      <dl className="dashboard-summary">
        <div>
          <dt>{t("dashboard.deterministic")}</dt>
          <dd>
            {data.deterministicShare === null
              ? "—"
              : formatShare(data.deterministicShare)}
          </dd>
          <p>
            {t("dashboard.deterministicCount", {
              count: data.deterministic,
              total: data.handled,
            })}
          </p>
        </div>
        <div>
          <dt>{t("dashboard.pending")}</dt>
          <dd>
            <Link to="/inbox?processing=awaiting_approval">
              {new Intl.NumberFormat().format(data.pendingApprovals)}
            </Link>
          </dd>
        </div>
        <div>
          <dt>{t("dashboard.active")}</dt>
          <dd>{new Intl.NumberFormat().format(data.activeRecipes)}</dd>
        </div>
      </dl>
      <section
        className="dashboard-chart-panel"
        ref={setChartBoundary}
        aria-label={t("dashboard.memory")}
      >
        <div className="dashboard-chart-top">
          <h2 className="shop-serif">{t("dashboard.memory")}</h2>
        </div>
        <div className="dashboard-legend">
          <span><i data-handler="agent" />{t("dashboard.agent")}</span>
          <span><i data-handler="recipe" />{t("dashboard.recipe")}</span>
          <span>{t("dashboard.logScale")}</span>
        </div>
        <MemoryCurve samples={data.samples} boundary={chartBoundary} />
        <p className="dashboard-caption">
          {t("dashboard.scope", { count: data.handled })}
        </p>
        <p className="dashboard-coverage">
          {t("dashboard.coverage", {
            tokens: data.unknownTokens,
            time: data.unknownTime,
          })}
        </p>
      </section>
      <details className="shop-disclosure dashboard-method">
        <summary><span>{t("dashboard.records")}</span><span className="dashboard-table-label">{t("dashboard.viewTable")}</span></summary>
        <div className="dashboard-table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {["request", "completed", "handler", "tokens", "time"].map(
                  (key) => (
                    <th scope="col" key={key}>
                      {t(`dashboard.${key}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {data.samples.map((s) => (
                <tr key={s.requestId}>
                  <th scope="row">
                    <div className="dashboard-record-signature">
                      {s.handler === "recipe" && s.recipe && <MakerMark outcome={{ status: "completed", mode: "execute", recipeName: s.recipe.name, version: s.recipe.version, tokens: s.tokens }} />}
                      <span><Link to={requestPath(s.requestId)}>{s.requestId}</Link>
                        {s.handler === "recipe" && s.recipe && <small>{s.recipe.name} · v{s.recipe.version}</small>}
                      </span>
                    </div>
                  </th>
                  <td>{dateText(new Date(s.completedAt).toISOString())}</td>
                  <td>{t(`dashboard.${s.handler}`)}</td>
                  <td>
                    {s.tokens === null
                      ? t("dashboard.unknownValue")
                      : formatTokens(s.tokens)}
                    <p className="dashboard-record-breakdown">
                      <TokenBreakdown
                        intake={s.intakeTokens}
                        run={s.runTokens}
                        total={s.tokens}
                        agent={s.agentTokens}
                        handler={s.handler}
                      />
                    </p>
                  </td>
                  <td>
                    {s.durationMs === null
                      ? t("dashboard.unknownValue")
                      : formatDuration(s.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <section className="dashboard-comparison">
        <h2 className="shop-serif">{t("dashboard.compare")}</h2>
        <p className="dashboard-caption">
          {t(data.hasMore ? "dashboard.truncated" : "dashboard.cohort", {
            limit: data.limit,
          })}
        </p>
        <div className="dashboard-table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("dashboard.requestType")}</th>
                <th scope="col">{t("dashboard.agent")}</th>
                <th scope="col">{t("dashboard.recipe")}</th>
              </tr>
            </thead>
            <tbody>
              {data.comparisons.map((row) => (
                <tr key={row.requestType}>
                  <th scope="row">{t(`shop.types.${row.requestType}`)}</th>
                  <CostCell cost={row.agent} />
                  <CostCell cost={row.recipe} recipe />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dashboard-caption mt-4">
          {t("dashboard.comparisonNote")}
        </p>
      </section>
      <details className="shop-disclosure dashboard-method">
        <summary>{t("dashboard.method")}</summary>
        <div>
          {[
            "methodCohort",
            "methodTokens",
            "methodAgent",
            "methodTime",
            "methodChart",
          ].map((key) => (
            <p key={key}>{t(`dashboard.${key}`)}</p>
          ))}
        </div>
      </details>
    </div>
  );
}
