import { useT } from "@agent-native/core/client/i18n";
import type { HandlingSample } from "@muscle-memory/shop-domain";
import { useId } from "react";
import { Link } from "react-router";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { requestPath } from "@/lib/shop-workspace";
import { CostTag } from "../kiln/CostTag";
import { formatDuration, formatTokens, formatTokenTick } from "./dashboard-format";
import { formatShare, runningZeroShare } from "./dashboard-metrics";
import { COST_PLOT, costScale } from "./dashboard-scale";
import { EmptyState } from "./WorkspaceParts";

export function MemoryCurve({ samples, boundary }: { samples: readonly HandlingSample[]; boundary: HTMLElement | null }) {
  const t = useT();
  const id = useId();
  if (!samples.length) return <EmptyState title={t("dashboard.empty")}>
    <p className="mt-3 max-w-md text-sm text-muted-foreground">{t("dashboard.emptyHint")}</p>
  </EmptyState>;
  const scale = costScale(samples.map(sample => sample.tokens), "tokens");
  const shares = runningZeroShare(samples);
  const x = (i: number) => COST_PLOT.left + (samples.length === 1 ? 0.5 : i / (samples.length - 1)) * (COST_PLOT.right - COST_PLOT.left);
  const shareY = (share: number) => 154 - share * 120;
  const orderLabels = (y: number) => <>
    <text x={x(0)} y={y}>#1</text>
    {samples.length > 1 && <text x={COST_PLOT.right} y={y} textAnchor="end">#{samples.length}</text>}
  </>;
  return <TooltipProvider delayDuration={0}>
    <figure className="dashboard-memory" aria-label={t("dashboard.memory")}>
      <div className="dashboard-curve" tabIndex={0} aria-label={t("dashboard.chartScroll")}>
        <div className="dashboard-plots">
          <h3 id={`${id}-tokens`}>{t("dashboard.tokensPerRequest")}</h3>
          <svg viewBox={`0 0 ${COST_PLOT.width} ${COST_PLOT.height}`} role="group" aria-labelledby={`${id}-tokens`}>
            {scale.ticks.map(value => <g key={value} className="dashboard-axis-tick" data-value={value}>
              <line x1={COST_PLOT.left} x2={COST_PLOT.right} y1={scale.y(value)!} y2={scale.y(value)!} className="dashboard-grid" />
              <text x={COST_PLOT.left - 16} y={scale.y(value)! + 5} textAnchor="end">{formatTokenTick(value)}</text>
            </g>)}
            <g className="dashboard-zero-lane">
              <rect x={COST_PLOT.left} y={COST_PLOT.zero - 17} width={COST_PLOT.right - COST_PLOT.left} height="34" rx="5" />
              <text x={COST_PLOT.left - 16} y={COST_PLOT.zero + 5} textAnchor="end">{t("dashboard.zeroTokens")}</text>
            </g>
            {samples.map((sample, index) => {
              const y = scale.y(sample.tokens);
              if (y === null) return null;
              const handler = sample.handler === "recipe" && sample.recipe ? `${t("dashboard.recipe")} · ${sample.recipe.name} v${sample.recipe.version}` : t(`dashboard.${sample.handler}`);
              const time = sample.durationMs === null ? t("dashboard.unknownValue") : formatDuration(sample.durationMs);
              const value = (tokens: number | null) => tokens === null ? t("dashboard.unknownValue") : formatTokens(tokens);
              const split = sample.handler === "agent" ? t("dashboard.agentBreakdown", { agent: value(sample.agentTokens), intake: value(sample.intakeTokens), run: value(sample.runTokens) }) :
                t("dashboard.breakdown", { intake: value(sample.intakeTokens), run: value(sample.runTokens) });
              const label = `${sample.requestId} · ${handler} · ${formatTokens(sample.tokens!)} ${t("dashboard.tokenUnit")} · ${time} · ${split}`;
              return <Tooltip key={sample.requestId}>
                <TooltipTrigger asChild>
                  <Link to={requestPath(sample.requestId)} className="dashboard-point" data-handler={sample.handler} data-request-id={sample.requestId}
                    data-value={sample.tokens} data-lane={sample.tokens === 0 ? "zero" : "log"} aria-label={label}>
                    <title>{label}</title>
                    <circle className="dashboard-hit" cx={x(index)} cy={y} r="22" />
                    {sample.handler === "agent" ? <rect className="dashboard-mark" x={x(index) - 7} y={y - 7} width="14" height="14" rx="1" /> :
                      <circle className="dashboard-mark" cx={x(index)} cy={y} r="7" />}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="dashboard-tooltip" side="top" avoidCollisions collisionBoundary={boundary} collisionPadding={12} sticky="always" hideWhenDetached>
                  <strong>{sample.requestId}</strong><span>{handler}</span>
                  <CostTag tokens={sample.tokens} durationMs={sample.durationMs} handler={sample.handler === "agent" ? "agent" : "recipe"} />
                  {sample.durationMs === null && <span>{t("dashboard.time")} · {time}</span>}
                  <span>{split}</span>
                </TooltipContent>
              </Tooltip>;
            })}
            {orderLabels(439)}
          </svg>
          <h3 id={`${id}-share`}>{t("dashboard.runningShare")}</h3>
          <svg viewBox={`0 0 ${COST_PLOT.width} 210`} role="img" aria-label={`${t("dashboard.runningShare")} · ${formatShare(shares[shares.length - 1]!.share)}`}>
            {[0, 0.5, 1].map(share => <g key={share}>
              <line x1={COST_PLOT.left} x2={COST_PLOT.right} y1={shareY(share)} y2={shareY(share)} className="dashboard-grid" />
              <text x={COST_PLOT.left - 16} y={shareY(share) + 5} textAnchor="end">{formatShare(share)}</text>
            </g>)}
            <polyline className="dashboard-share-line" points={shares.map((point, index) => `${x(index)},${shareY(point.share)}`).join(" ")} />
            {shares.map((point, index) => <circle key={point.requestId} className="dashboard-share-point" cx={x(index)} cy={shareY(point.share)} r="2"
              data-share={point.share} data-request-id={point.requestId} />)}
            <text className="dashboard-share-label" x={x(shares.length - 1)} y={shareY(shares[shares.length - 1]!.share) - 14} textAnchor={shares.length > 1 ? "end" : "middle"}>
              {formatShare(shares[shares.length - 1]!.share)}
            </text>
            {orderLabels(193)}
          </svg>
        </div>
      </div>
      <figcaption>{t("dashboard.sequence")}</figcaption>
    </figure>
  </TooltipProvider>;
}
