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

import {
  axisDates,
  formatDuration,
  formatTimeTick,
  formatTokens,
  formatTokenTick,
} from "./dashboard-format";
import { COST_PLOT, costScale, type CostMetric } from "./dashboard-scale";
import { EmptyState, QueryError, ShopMasthead } from "./WorkspaceParts";

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

function CostCurve({
  samples,
  metric,
}: {
  samples: readonly HandlingSample[];
  metric: CostMetric;
}) {
  const t = useT();
  if (!samples.some((s) => s[metric] !== null))
    return (
      <EmptyState title={t("dashboard.empty")}>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          {t("dashboard.emptyHint")}
        </p>
      </EmptyState>
    );
  const scale = costScale(
    samples.map((s) => s[metric]),
    metric,
  );
  const x = (i: number) =>
    COST_PLOT.left +
    (samples.length === 1 ? 0.5 : i / (samples.length - 1)) *
      (COST_PLOT.right - COST_PLOT.left);
  const labels = axisDates(samples.map((s) => s.completedAt));
  const tickLabel = metric === "tokens" ? formatTokenTick : formatTimeTick;
  return (
    <figure
      className="dashboard-curve"
      tabIndex={0}
      aria-label={t("dashboard.trend")}
    >
      <svg
        viewBox={`0 0 ${COST_PLOT.width} ${COST_PLOT.height}`}
        role="img"
        aria-label={`${t("dashboard.trend")} · ${t(metric === "tokens" ? "dashboard.tokens" : "dashboard.time")} · ${t("dashboard.logScale")}`}
      >
        {scale.ticks.map((value) => (
          <g key={value} className="dashboard-axis-tick" data-value={value}>
            <line
              x1={COST_PLOT.left}
              x2={COST_PLOT.right}
              y1={scale.y(value)!}
              y2={scale.y(value)!}
              className="dashboard-grid"
            />
            <text
              x={COST_PLOT.left - 16}
              y={scale.y(value)! + 5}
              textAnchor="end"
            >
              {tickLabel(value)}
            </text>
          </g>
        ))}
        <g className="dashboard-zero-lane">
          <rect
            x={COST_PLOT.left}
            y={COST_PLOT.zero - 17}
            width={COST_PLOT.right - COST_PLOT.left}
            height="34"
            rx="5"
          />
          <text x={COST_PLOT.left - 16} y={COST_PLOT.zero + 5} textAnchor="end">
            {t(
              metric === "tokens"
                ? "dashboard.zeroTokens"
                : "dashboard.zeroTime",
            )}
          </text>
        </g>
        {samples.map((s, i) => {
          const y = scale.y(s[metric]);
          if (y === null) return null;
          const value =
            metric === "tokens"
              ? `${formatTokens(s.tokens!)} ${t("dashboard.tokenUnit")}`
              : formatDuration(s.durationMs!);
          return (
            <g
              key={s.requestId}
              className="dashboard-point"
              data-handler={s.handler}
              data-request-id={s.requestId}
              data-value={s[metric]}
              data-lane={s[metric] === 0 ? "zero" : "log"}
            >
              {s.handler === "agent" ? (
                <rect x={x(i) - 6} y={y - 6} width="12" height="12" rx="1" />
              ) : (
                <circle cx={x(i)} cy={y} r="6" />
              )}
              <title>{`${s.requestId} · ${t(`dashboard.${s.handler}`)} · ${value} · ${breakdownText({ intake: s.intakeTokens, run: s.runTokens, total: s.tokens, agent: s.agentTokens, handler: s.handler }, t, false)} · ${dateText(new Date(s.completedAt).toISOString())}`}</title>
            </g>
          );
        })}
        <text x={COST_PLOT.left} y="439">
          {labels[0]}
        </text>
        <text x={COST_PLOT.right} y="439" textAnchor="end">
          {samples.length > 1 ? labels[labels.length - 1] : ""}
        </text>
      </svg>
      <figcaption>{t("dashboard.sequence")}</figcaption>
    </figure>
  );
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

function HeadToHead({
  handler,
  cost,
}: {
  handler: "agent" | "recipe";
  cost: HandlingCost;
}) {
  const t = useT();
  return (
    <div className="dashboard-handler-cost" data-handler={handler}>
      <h2>
        {handler === "agent" ? "■ " : "● "}
        {t(`dashboard.${handler}`)}
      </h2>
      <p className="dashboard-headline-cost">
        <CostValue cost={cost} />
      </p>
      <div className="dashboard-caption">
        {t("dashboard.perRequest")} · <SampleCount cost={cost} />
      </div>
      {handler === "recipe" && cost.tokenSamples > 0 && (
        <p className="dashboard-breakdown">
          <TokenBreakdown
            intake={cost.meanIntakeTokens}
            run={cost.meanRunTokens}
            total={cost.meanTokens}
          />
          {cost.breakdownSamples !== cost.tokenSamples && (
            <span>
              {" "}
              ·{" "}
              {t("dashboard.breakdownCount", { count: cost.breakdownSamples })}
            </span>
          )}
        </p>
      )}
    </div>
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
  const [metric, setMetric] = useState<CostMetric>("tokens");
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
      <dl className="dashboard-summary">
        <div>
          <dt>{t("dashboard.deterministic")}</dt>
          <dd>
            {data.deterministicShare === null
              ? "—"
              : new Intl.NumberFormat(undefined, {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(data.deterministicShare)}
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
        aria-label={t("dashboard.overall")}
      >
        <div className="dashboard-head-to-head">
          <HeadToHead handler="agent" cost={data.overall.agent} />
          <HeadToHead handler="recipe" cost={data.overall.recipe} />
        </div>
        <p className="dashboard-caption dashboard-cohort-note">
          {t("dashboard.overallNote")}
        </p>
        <div className="dashboard-chart-top">
          <h2>{t("dashboard.trend")}</h2>
          <div
            className="flex gap-1"
            role="group"
            aria-label={t("dashboard.trend")}
          >
            <Button
              size="sm"
              variant={metric === "tokens" ? "secondary" : "ghost"}
              aria-pressed={metric === "tokens"}
              onClick={() => setMetric("tokens")}
            >
              {t("dashboard.tokens")}
            </Button>
            <Button
              size="sm"
              variant={metric === "durationMs" ? "secondary" : "ghost"}
              aria-pressed={metric === "durationMs"}
              onClick={() => setMetric("durationMs")}
            >
              {t("dashboard.time")}
            </Button>
          </div>
        </div>
        <div className="dashboard-legend">
          <span data-handler="agent">■ {t("dashboard.agent")}</span>
          <span data-handler="recipe">● {t("dashboard.recipe")}</span>
          <span>{t("dashboard.logScale")}</span>
        </div>
        <CostCurve samples={data.samples} metric={metric} />
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
      <details className="shop-disclosure dashboard-method">
        <summary>{t("dashboard.records")}</summary>
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
                    <Link to={requestPath(s.requestId)}>{s.requestId}</Link>
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
    </div>
  );
}
