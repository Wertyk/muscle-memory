import { defineActionErrors } from "@agent-native/core/action";
import {
  ID_PREFIXES, REQUEST_STATUSES, REQUEST_TYPES,
  type Address, type IdKind, type Result, type ShopError, type ShopId,
} from "@muscle-memory/shop-domain";
import { z } from "zod";

// The regex enforces the domain's template-literal type at the JSON boundary.
export const shopId = <K extends IdKind>(kind: K) => z.string().max(31)
  .regex(new RegExp(`^${ID_PREFIXES[kind]}_[a-z0-9]+$`)) as z.ZodType<ShopId<K>, ShopId<K>>;
export const nonEmpty = z.string().trim().min(1);
export const moneySchema = z.object({
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Non-negative safe integer in minor units; USD cents"),
  currency: z.string().regex(/^[A-Z]{3}$/).describe("Uppercase three-letter currency, e.g. USD"),
});
export const addressSchema = z.object({
  name: nonEmpty.describe("Recipient name"),
  line1: nonEmpty.describe("Street address"),
  line2: z.string().optional().describe("Apartment or suite; omit when absent"),
  city: nonEmpty.describe("City"),
  region: nonEmpty.describe("State or region"),
  postalCode: nonEmpty.describe("Postal code"),
  countryCode: z.string().regex(/^[A-Z]{2}$/).describe("Uppercase two-letter country, e.g. US"),
}) as z.ZodType<Address, Address>;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export const orderStatusSchema = z.enum(["unshipped", "shipped", "delivered", "cancelled"]);
export const returnLabelSchema = z.object({
  id: shopId("returnLabel"), orderId: shopId("order"), createdAt: z.string(), fromAddress: addressSchema,
});
export const orderSchema = z.object({
  id: shopId("order"), customerId: shopId("customer"),
  items: z.array(z.object({ productId: shopId("product"), name: z.string(), quantity: z.number().int().positive(), unitPrice: moneySchema })).readonly(),
  total: moneySchema, paid: moneySchema, status: orderStatusSchema, shippingAddress: addressSchema,
  createdAt: z.string(), deliveredAt: z.string().nullable(),
  replacementForOrderId: shopId("order").nullable(), returnLabel: returnLabelSchema.nullable(),
});
export const customerSchema = z.object({
  id: shopId("customer"), name: z.string(), email: z.string(), shippingAddress: addressSchema,
});
export const shipmentStatusSchema = z.object({
  orderStatus: orderStatusSchema,
  shipment: z.object({
    id: shopId("shipment"), orderId: shopId("order"),
    status: z.enum(["pending", "in_transit", "delivered", "exception", "cancelled"]),
    carrier: z.string(), trackingNumber: z.string().nullable(), shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(), estimatedDeliveryAt: z.string().nullable(),
  }).nullable(),
});
const structuredFields = z.discriminatedUnion("type", [
  z.object({ type: z.literal("damaged_item"), orderId: shopId("order"), productId: shopId("product"), quantity: z.number().int().positive(), description: z.string() }),
  z.object({ type: z.literal("where_is_my_order"), orderId: shopId("order") }),
  z.object({ type: z.literal("return"), orderId: shopId("order"), reason: z.string() }),
  z.object({ type: z.literal("address_change"), orderId: shopId("order"), address: addressSchema }),
  z.object({ type: z.literal("wholesale_inquiry"), company: z.string(), message: z.string() }),
]);
export const requestSchema = z.object({
  id: shopId("request"), customerId: shopId("customer"), orderId: shopId("order").nullable(), subject: z.string(),
  content: z.discriminatedUnion("source", [
    z.object({ source: z.literal("structured"), fields: structuredFields }),
    z.object({ source: z.literal("free_text"), text: z.string(), type: z.enum(REQUEST_TYPES).nullable() }),
  ]),
  status: requestStatusSchema, tags: z.array(z.string()).readonly(), createdAt: z.string(), updatedAt: z.string(),
  escalation: z.object({ reason: z.string(), escalatedAt: z.string() }).nullable(),
});
export const refundSchema = z.object({
  id: shopId("refund"), orderId: shopId("order"), amount: moneySchema, reason: z.string(), createdAt: z.string(),
});
export const replySchema = z.object({
  id: shopId("reply"), requestId: shopId("request"), customerId: shopId("customer"),
  to: z.string(), template: z.string(), variables: z.record(z.string(), z.union([z.string(), z.number()])),
  body: z.string(), createdAt: z.string(),
});

const activityEntry = z.object({ id: z.string(), at: z.string() });
export const requestActivitySchema = z.discriminatedUnion("kind", [
  activityEntry.extend({ kind: z.literal("request_received") }),
  activityEntry.extend({ kind: z.literal("order_placed"), orderId: shopId("order") }),
  activityEntry.extend({ kind: z.literal("dispatched"), carrier: z.string() }),
  activityEntry.extend({ kind: z.literal("delivered") }),
  activityEntry.extend({ kind: z.literal("reply"), bodyExcerpt: z.string() }),
  activityEntry.extend({ kind: z.literal("refund"), amount: moneySchema, reason: z.string() }),
  activityEntry.extend({ kind: z.literal("replacement"), orderId: shopId("order"), items: z.array(z.object({ name: z.string(), quantity: z.number().int().positive() })).readonly() }),
  activityEntry.extend({ kind: z.literal("return_label"), labelId: shopId("returnLabel") }),
  activityEntry.extend({ kind: z.literal("recorded_state"), status: requestStatusSchema, tags: z.array(z.string()).readonly() }),
  activityEntry.extend({ kind: z.literal("escalation"), reason: z.string() }),
]);

export const shopErrors = defineActionErrors(
  "NOT_FOUND", "INVALID_INPUT", "CURRENCY_MISMATCH", "REFUND_EXCEEDS_BALANCE",
  "RETURN_WINDOW_EXPIRED", "ORDER_NOT_DELIVERED", "ORDER_CANCELLED",
  "ADDRESS_CHANGE_NOT_ALLOWED", "MISSING_TEMPLATE_VARIABLE",
);

/** Zod optional fields include undefined; domain ports use exact optional keys. */
export function definedFields<T extends object>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function errorMessage(error: ShopError): string {
  switch (error.code) {
    case "NOT_FOUND": return `No ${error.entity} found for ${error.id}.`;
    case "INVALID_INPUT": return `${error.field}: ${error.message}`;
    case "CURRENCY_MISMATCH": return `Expected ${error.expected}, received ${error.actual}.`;
    case "REFUND_EXCEEDS_BALANCE": return `Refund exceeds remaining payment (${error.availableMinor} minor units).`;
    case "RETURN_WINDOW_EXPIRED": return `The ${error.days}-day return window has expired.`;
    case "ORDER_NOT_DELIVERED": return "A return label requires a delivered order.";
    case "ORDER_CANCELLED": return "A cancelled order cannot be replaced.";
    case "ADDRESS_CHANGE_NOT_ALLOWED": return "Shipping address can only change before dispatch.";
    case "MISSING_TEMPLATE_VARIABLE": return `Supply template variable ${error.variable}.`;
  }
}

/** Shop policy rejections happen before writes; failed transactions roll back. */
export async function shopResult<T>(result: Promise<Result<T>>): Promise<T> {
  const resolved = await result;
  if (resolved.ok) return resolved.value;
  const error = resolved.error;
  return shopErrors.noWrite(errorMessage(error), error.code, {
    statusCode: error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_INPUT" ? 400 : 409,
    details: { ...error },
  });
}
