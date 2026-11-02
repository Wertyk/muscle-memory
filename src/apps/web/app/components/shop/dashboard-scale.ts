export type CostMetric = "tokens" | "durationMs";
export const COST_PLOT = {
  left: 180,
  right: 940,
  top: 36,
  bottom: 334,
  zero: 390,
  width: 980,
  height: 456,
} as const;

/** Zero has its own lane. No offset, epsilon or clamping is applied to observations. */
export function costScale(
  values: readonly (number | null)[],
  metric: CostMetric,
) {
  const positive = values.filter(
    (value): value is number => value !== null && value > 0,
  );
  const low = Math.min(metric === "tokens" ? 1 : 10, ...positive);
  const min = 10 ** Math.floor(Math.log10(low));
  const highest = Math.max(
    metric === "tokens" ? 1_000_000 : 60_000,
    ...positive,
  );
  const max =
    metric === "tokens" || highest > 60_000
      ? 10 ** Math.ceil(Math.log10(highest))
      : 60_000;
  const ticks: number[] = [];
  for (let value = min; value <= max; value *= 10) ticks.push(value);
  if (!ticks.includes(max)) ticks.push(max);
  return {
    ticks,
    y(value: number | null): number | null {
      if (value === null) return null;
      if (value === 0) return COST_PLOT.zero;
      return (
        COST_PLOT.bottom -
        ((Math.log10(value) - Math.log10(min)) /
          (Math.log10(max) - Math.log10(min))) *
          (COST_PLOT.bottom - COST_PLOT.top)
      );
    },
  };
}
