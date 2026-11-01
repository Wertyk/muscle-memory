import type { Address, Order, OrderLineItem, Refund, ReplacementItemSelection, Shipment } from "./entities.js";
import { addMoney, money, type Money } from "./money.js";
import { failure, invalidInput, success, type Result } from "./result.js";

export const RETURN_WINDOW_DAYS = 30;
export const AUTO_REFUND_LIMIT: Money = { amountMinor: 10_000, currency: "USD" };
const DAY_MS = 24 * 60 * 60 * 1_000;

export function refundableBalance(order: Order, refunds: readonly Refund[]): Result<Money> {
  const paid = money(order.paid.amountMinor, order.paid.currency);
  if (!paid.ok) return paid;
  let remaining = paid.value.amountMinor;
  for (const refund of refunds) {
    if (refund.orderId !== order.id) return invalidInput("refunds", "Refund belongs to another order");
    const amount = money(refund.amount.amountMinor, refund.amount.currency);
    if (!amount.ok) return amount;
    if (amount.value.currency !== order.paid.currency) {
      return failure({ code: "CURRENCY_MISMATCH", expected: order.paid.currency, actual: amount.value.currency });
    }
    remaining -= amount.value.amountMinor;
    if (remaining < 0) return invalidInput("refunds", "Prior refunds exceed the amount paid");
  }
  return money(remaining, order.paid.currency);
}

export function checkRefund(order: Order, refunds: readonly Refund[], amount: Money): Result<Money> {
  const valid = money(amount.amountMinor, amount.currency);
  if (!valid.ok) return valid;
  if (amount.amountMinor === 0) return invalidInput("amountMinor", "Refund must be positive");
  const balance = refundableBalance(order, refunds);
  if (!balance.ok) return balance;
  if (amount.currency !== balance.value.currency) {
    return failure({ code: "CURRENCY_MISMATCH", expected: balance.value.currency, actual: amount.currency });
  }
  return amount.amountMinor <= balance.value.amountMinor
    ? success(amount)
    : failure({ code: "REFUND_EXCEEDS_BALANCE", availableMinor: balance.value.amountMinor });
}

/** Approval is enforced by the caller/recipe gate, never by a shop UI-only path. */
export function isWithinAutoRefundLimit(amount: Money): boolean {
  return money(amount.amountMinor, amount.currency).ok && amount.amountMinor > 0 &&
    amount.currency === AUTO_REFUND_LIMIT.currency && amount.amountMinor <= AUTO_REFUND_LIMIT.amountMinor;
}

/** Returns are allowed through exactly 30 elapsed days after delivery. */
export function checkReturnWindow(order: Order, now: string): Result<void> {
  if (order.status !== "delivered" || !order.deliveredAt) return failure({ code: "ORDER_NOT_DELIVERED" });
  const elapsed = Date.parse(now) - Date.parse(order.deliveredAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return invalidInput("deliveredAt", "Invalid delivery/clock timestamp");
  return elapsed <= RETURN_WINDOW_DAYS * DAY_MS
    ? success(undefined)
    : failure({ code: "RETURN_WINDOW_EXPIRED", days: RETURN_WINDOW_DAYS });
}

export function checkAddressChange(order: Order, shipment: Shipment | null): Result<void> {
  return order.status === "unshipped" && (!shipment || (shipment.status === "pending" && shipment.shippedAt === null))
    ? success(undefined)
    : failure({ code: "ADDRESS_CHANGE_NOT_ALLOWED" });
}

/** Select original purchased lines and recompute their value at original unit prices. */
export function replacementContents(
  order: Order, selection: readonly ReplacementItemSelection[] = order.items,
): Result<Pick<Order, "items" | "total">> {
  if (order.status === "cancelled") return failure({ code: "ORDER_CANCELLED" });
  if (selection.length === 0) return invalidInput("items", "Select at least one replacement item");
  const seen = new Set<string>();
  const items: OrderLineItem[] = [];
  const initialTotal = money(0, order.total.currency);
  if (!initialTotal.ok) return initialTotal;
  let total = initialTotal.value;
  for (const selected of selection) {
    if (seen.has(selected.productId)) return invalidInput("items.productId", "Duplicate replacement product");
    seen.add(selected.productId);
    const original = order.items.find((item) => item.productId === selected.productId);
    if (!original) return invalidInput("items.productId", "Product is not on the original order");
    if (!Number.isSafeInteger(selected.quantity) || selected.quantity <= 0 || selected.quantity > original.quantity) {
      return invalidInput("items.quantity", "Expected a positive integer no greater than the ordered quantity");
    }
    const unitPrice = money(original.unitPrice.amountMinor, original.unitPrice.currency);
    if (!unitPrice.ok) return unitPrice;
    const lineTotal = money(unitPrice.value.amountMinor * selected.quantity, unitPrice.value.currency);
    if (!lineTotal.ok) return lineTotal;
    const updatedTotal = addMoney(total, lineTotal.value);
    if (!updatedTotal.ok) return updatedTotal;
    total = updatedTotal.value;
    items.push({ ...original, quantity: selected.quantity, unitPrice: unitPrice.value });
  }
  return success({ items, total });
}

export function validateAddress(address: Address): Result<Address> {
  for (const field of ["name", "line1", "city", "region", "postalCode"] as const) {
    if (!address[field].trim()) return invalidInput(`address.${field}`, "Address field is required");
  }
  return /^[A-Z]{2}$/.test(address.countryCode)
    ? success({ ...address })
    : invalidInput("address.countryCode", "Expected a two-letter uppercase country code");
}
