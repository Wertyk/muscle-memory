import type { JsonObject, JsonValue } from "@muscle-memory/recipe-engine";

import { moneyText } from "./shop-workspace";

export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;
export const recipeVersionPath = (recipeId: string, versionId: string) =>
  `/recipes/${encodeURIComponent(recipeId)}?version=${encodeURIComponent(versionId)}`;
export function runIdFromPath(path: string): string | undefined {
  const encoded = path.match(/^\/runs\/([^/]+)\/?$/)?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : undefined;
  } catch {
    return undefined;
  }
}
export function durationText(ms: number) {
  return ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(2)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
}
/** Bounded human summaries; complete, resolved JSON remains in the disclosure. */
export function valueSummary(value: JsonValue, depth = 0): string {
  if (value === null) return "—";
  if (typeof value !== "object") return String(value).slice(0, 220);
  if (depth > 2) return Array.isArray(value) ? `${value.length} items` : "…";
  if (Array.isArray(value))
    return (
      value
        .slice(0, 3)
        .map((item) => valueSummary(item, depth + 1))
        .join(" · ") + (value.length > 3 ? ` · +${value.length - 3}` : "")
    );
  const object = value as JsonObject;
  if (
    typeof object.amountMinor === "number" &&
    typeof object.currency === "string" &&
    /^[A-Z]{3}$/.test(object.currency)
  ) {
    try {
      return moneyText({
        amountMinor: object.amountMinor,
        currency: object.currency,
      });
    } catch {
      /* Fall through to resolved fields. */
    }
  }
  const entries = Object.entries(value);
  const preferred = [
    "body",
    "amount",
    "orderId",
    "requestId",
    "tag",
    "reason",
    "status",
    "orderStatus",
    "note",
    "id",
  ];
  const ordered = [...entries].sort(([a], [b]) => {
    const rank = (key: string) => {
      const i = preferred.indexOf(key);
      return i < 0 ? preferred.length : i;
    };
    return rank(a) - rank(b);
  });
  return ordered
    .slice(0, 4)
    .map(
      ([key, v]) =>
        `${key.replace(/([a-z])([A-Z])/g, "$1 $2")}: ${valueSummary(v, depth + 1)}`,
    )
    .join(" · ")
    .slice(0, 350);
}
