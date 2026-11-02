import type { DemonstrationStep, JsonObject, JsonValue } from "@muscle-memory/recipe-engine";

import { moneyText } from "@/lib/shop-workspace";

/** Both the live clock and saved duration use the persisted start, never mount time. */
export function elapsedTime(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function actionIcon(action: string) {
  switch (action) {
    case "issue-refund": return "receipt";
    case "send-reply": return "message";
    case "tag-request": return "tag";
    case "create-replacement-order": return "package";
    case "update-shipping-address": return "pin";
    default: return "bolt";
  }
}

/** Short labels from actual captured inputs/results, never invented outcomes. */
export function stepArgument(step: DemonstrationStep): string {
  const a = step.input;
  const target = [a.requestId, a.orderId, a.customerId].find(
    (v) => typeof v === "string",
  );
  const object = (value: JsonValue | undefined): JsonObject =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : {};
  const output = object(step.output);
  if (step.action === "send-reply" && typeof output.body === "string")
    return output.body;
  if (step.action === "update-shipping-address") {
    const address = object(a.address);
    return [address.line1, address.city]
      .filter((value) => typeof value === "string")
      .join(", ");
  }
  if (step.action === "create-replacement-order" && Array.isArray(output.items))
    return output.items
      .map((item) => {
        const line = object(item);
        return `${line.quantity} × ${line.name ?? line.productId}`;
      })
      .join(", ");
  const amount = object(
    a.amount ?? (step.action === "issue-refund" ? output.amount : undefined),
  );
  if (
    typeof amount.amountMinor === "number" &&
    typeof amount.currency === "string"
  )
    return `${moneyText({ amountMinor: amount.amountMinor, currency: amount.currency })} · ${target ?? ""}`;
  const value = a.tag ?? a.status ?? a.reason ?? a.template ?? a.body;
  if (typeof value === "string") return value;
  return typeof target === "string"
    ? target
    : Object.entries(a)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(" · ");
}
