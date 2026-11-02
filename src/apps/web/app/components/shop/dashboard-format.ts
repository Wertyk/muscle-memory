/** Display-only rounding; stored measurements and statistics retain their precision. */
export function formatTokens(value: number, locale?: string) {
  const whole = Math.round(value);
  return new Intl.NumberFormat(locale, {
    notation: whole >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 0,
  }).format(whole);
}

function unit(
  value: number,
  name: "millisecond" | "second" | "minute",
  locale?: string,
) {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: name === "minute" ? "short" : "narrow",
    maximumFractionDigits: 1,
  })
    .formatToParts(value)
    .reduce((result, part) => {
      const gap =
        part.type === "unit" &&
        name !== "minute" &&
        result &&
        !/\s$/.test(result)
          ? " "
          : "";
      return result + gap + part.value;
    }, "");
}

export function formatDuration(ms: number, locale?: string) {
  return ms >= 1000
    ? unit(ms / 1000, "second", locale)
    : unit(ms, "millisecond", locale);
}

export function formatRatio(value: number, locale = "en-US") {
  const digits = value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}×`;
}

export function formatTokenTick(value: number, locale?: string) {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
export function formatTimeTick(ms: number, locale?: string) {
  return ms >= 60_000
    ? unit(ms / 60_000, "minute", locale)
    : formatDuration(ms, locale);
}

export function axisDates(
  timestamps: readonly number[],
  locale?: string,
  timeZone?: string,
): string[] {
  const zone = timeZone ? { timeZone } : {};
  const days = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zone,
  });
  const sameDay =
    new Set(timestamps.map((value) => days.format(value))).size <= 1;
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
    ...(!sameDay ? { month: "short" as const, day: "numeric" as const } : {}),
  });
  return timestamps.map((value) => formatter.format(value));
}
