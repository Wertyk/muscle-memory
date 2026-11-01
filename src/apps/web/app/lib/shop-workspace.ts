export const INBOX_PATH = "/inbox";
export const requestPath = (id: string) =>
  `/requests/${encodeURIComponent(id)}`;

export function requestIdFromPath(path: string): string | undefined {
  const encoded = path.match(/^\/requests\/([^/]+)\/?$/)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function moneyText(money: { amountMinor: number; currency: string }) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: money.currency,
  }).format(money.amountMinor / 100);
}

export function dateText(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function ageText(timestamp: string, now = Date.now()) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(timestamp)) / 60_000),
  );
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return formatter.format(-minutes, "minute");
  if (minutes < 1440)
    return formatter.format(-Math.floor(minutes / 60), "hour");
  return formatter.format(-Math.floor(minutes / 1440), "day");
}
