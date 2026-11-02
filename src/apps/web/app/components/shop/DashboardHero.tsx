import { useT } from "@agent-native/core/client/i18n";
import type { HandlingCost, HandlingStats } from "@muscle-memory/shop-domain";
import { useEffect, useRef, useState } from "react";

import { formatDuration, formatRatio, formatTokens } from "./dashboard-format";
import { handlingRatios } from "./dashboard-metrics";

// Solve the CSS cubic-bezier's x coordinate before reading its y coordinate.
function easingAt(progress: number, easing: string) {
  const [x1 = 0.22, y1 = 1, x2 = 0.36, y2 = 1] = easing.match(/[\d.]+/g)?.map(Number) ?? [];
  const cubic = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(mid, x1, x2) < progress) lo = mid;
    else hi = mid;
  }
  return cubic((lo + hi) / 2, y1, y2);
}

function useFirstCountUp() {
  const element = useRef<HTMLElement>(null);
  const completed = useRef(false);
  const started = useRef<number | null>(null);
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches || completed.current) return;
    const style = getComputedStyle(element.current!);
    const duration = ["--dur-3", "--dur-2"].reduce((sum, token) => sum + (parseFloat(style.getPropertyValue(token)) || 0), 0) || 720;
    const easing = style.getPropertyValue("--ease-kiln");
    let frame = 0;
    const finish = () => {
      completed.current = true;
      cancelAnimationFrame(frame);
      setProgress(1);
    };
    const tick = (now: number) => {
      started.current ??= now;
      const elapsed = Math.min(1, (now - started.current) / duration);
      if (elapsed === 1) finish();
      else {
        setProgress(easingAt(elapsed, easing));
        frame = requestAnimationFrame(tick);
      }
    };
    const onPreference = () => { if (preference.matches) finish(); };
    preference.addEventListener("change", onPreference);
    setProgress(0);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", onPreference);
    };
  }, []);
  return { element, progress };
}

function MeasuredNumber({ value, progress, format }: {
  value: number | null; progress: number; format: (value: number) => string;
}) {
  const t = useT();
  const final = value === null ? t("dashboard.unknownValue") : format(value);
  return <span data-measurement={value ?? "unknown"} title={value === null ? undefined : String(value)}>
    <span className="sr-only">{final}</span>
    <span aria-hidden="true">{value === null ? "—" : format(value * progress)}</span>
  </span>;
}

function sampleCountText(cost: HandlingCost, t: ReturnType<typeof useT>) {
  return cost.tokenSamples === cost.timeSamples ? t("dashboard.sampleCount", { count: cost.tokenSamples }) :
    t("dashboard.separateCounts", { tokens: cost.tokenSamples, time: cost.timeSamples });
}

function HeroColumn({ handler, cost, progress }: {
  handler: "agent" | "recipe"; cost: HandlingCost; progress: number;
}) {
  const t = useT();
  return <div className="dashboard-handler-cost" data-handler={handler}>
    <h2>{t(`dashboard.${handler}`)} <span>{t("dashboard.perRequest")}</span></h2>
    <div className="dashboard-hero-tokens">
      <MeasuredNumber value={cost.meanTokens} progress={progress} format={value => `${formatTokens(value)} ${t("dashboard.tokenUnit")}`} />
    </div>
    <div className="dashboard-hero-time">
      <MeasuredNumber value={cost.meanDurationMs} progress={progress} format={formatDuration} />
      <span>{t("dashboard.time")}</span>
    </div>
    <p className="dashboard-sample-count">
      {sampleCountText(cost, t)}
    </p>
    {handler === "recipe" && cost.tokenSamples > 0 && <p className="dashboard-breakdown">
      {t("dashboard.breakdown", {
        intake: cost.meanIntakeTokens === null ? t("dashboard.unknownValue") : formatTokens(cost.meanIntakeTokens),
        run: cost.meanRunTokens === null ? t("dashboard.unknownValue") : formatTokens(cost.meanRunTokens),
      })}
      {cost.breakdownSamples !== cost.tokenSamples && ` · ${t("dashboard.breakdownCount", { count: cost.breakdownSamples })}`}
    </p>}
  </div>;
}

export function DashboardHero({ overall }: { overall: HandlingStats["overall"] }) {
  const t = useT();
  const { element, progress } = useFirstCountUp();
  const ratios = handlingRatios(overall.agent, overall.recipe);
  const missing = [overall.agent, overall.recipe].some(cost => !cost.tokenSamples || !cost.timeSamples);
  return <section className="dashboard-hero" ref={element} aria-label={t("dashboard.overall")}>
    <div className="dashboard-head-to-head">
      <HeroColumn handler="agent" cost={overall.agent} progress={progress} />
      <HeroColumn handler="recipe" cost={overall.recipe} progress={progress} />
    </div>
    {(ratios.faster !== null || ratios.tokensAvoided !== null) && <div className="dashboard-ratios">
      {ratios.faster !== null && <p><strong>{formatRatio(ratios.faster)}</strong> {t("dashboard.faster")}</p>}
      {ratios.tokensAvoided !== null && <p><strong>{formatTokens(ratios.tokensAvoided)}</strong> {t("dashboard.avoided")}</p>}
      <p className="dashboard-ratio-qualifier">{t("dashboard.ratioCohort", { agent: sampleCountText(overall.agent, t), recipe: sampleCountText(overall.recipe, t) })}</p>
    </div>}
    {missing && <p className="dashboard-empty-comparison">{t("dashboard.unknown")} · {t("dashboard.emptyHint")}</p>}
    <p className="dashboard-caption dashboard-cohort-note">{t("dashboard.overallNote")}</p>
  </section>;
}
