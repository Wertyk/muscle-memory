export type RoundingMode = "round" | "floor" | "ceil";

/** Integer rounding for finite inputs; round breaks ties away from zero. */
export function roundToInteger(value: number, mode: RoundingMode): number {
  const result = mode === "round"
    ? Math.sign(value) * Math.round(Math.abs(value))
    : mode === "floor" ? Math.floor(value) : Math.ceil(value);
  // JSON and integer minor units have one zero, including for negative fractions.
  return result === 0 ? 0 : result;
}
