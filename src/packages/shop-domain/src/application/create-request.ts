import { z } from "zod";
import {
  ID_PREFIXES, parseShopId, success, invalidInput, notFound, validateAddress,
  type Address, type CustomerId, type IdKind, type Request, type Result, type ShopId, type StructuredRequestFields,
} from "../domain/index.js";
import type { ShopDependencies, ShopRecords } from "./ports.js";

const id = <K extends IdKind>(kind: K) => z.string().max(31)
  .regex(new RegExp(`^${ID_PREFIXES[kind]}_[a-z0-9]+$`)).describe(`Short ${kind} ID, starting with ${ID_PREFIXES[kind]}_`) as z.ZodType<ShopId<K>, ShopId<K>>;
const text = z.string().trim().min(1).max(4000);
const address = z.object({
  name: text, line1: text, line2: z.string().max(4000).optional(), city: text, region: text,
  postalCode: text, countryCode: z.string().regex(/^[A-Z]{2}$/),
}).strict().transform((value): Address => {
  const { line2, ...required } = value;
  return { ...required, ...(line2 === undefined ? {} : { line2 }) };
});
export const structuredRequestFieldsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("damaged_item"), orderId: id("order"), productId: id("product"), quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), description: text }).strict(),
  z.object({ type: z.literal("where_is_my_order"), orderId: id("order") }).strict(),
  z.object({ type: z.literal("return"), orderId: id("order"), reason: text }).strict(),
  z.object({ type: z.literal("address_change"), orderId: id("order"), address }).strict(),
  z.object({ type: z.literal("wholesale_inquiry"), company: text, message: text }).strict(),
]);
export const createRequestInputSchema = z.object({
  customerId: id("customer"), subject: z.string().trim().min(1).max(300).describe("Support request subject, 1–300 characters"),
  content: z.discriminatedUnion("source", [
    z.object({ source: z.literal("structured"), fields: structuredRequestFieldsSchema.describe("Complete typed fields; order must belong to customerId") }).strict(),
    z.object({ source: z.literal("free_text"), text: text.describe("Original customer message, 1–4000 characters; do not pre-classify") }).strict(),
  ]).describe("Structured fields for zero-token matching, or free_text for one cheap extraction call"),
}).strict();
export type CreateRequestInput = z.infer<typeof createRequestInputSchema>;

/** Also applied to extracted fields before any recipe gets access to an order. */
export class ValidateRequestFields {
  constructor(private readonly shop: Pick<ShopRecords, "getCustomer" | "getOrder">) {}
  async execute(input: { readonly customerId: CustomerId; readonly fields: unknown }): Promise<Result<StructuredRequestFields>> {
    const parsed = structuredRequestFieldsSchema.safeParse(input.fields);
    if (!parsed.success) return invalidInput("fields", "Incomplete or invalid request fields");
    if (!await this.shop.getCustomer(input.customerId)) return notFound("customer", input.customerId);
    const fields = parsed.data;
    if ("orderId" in fields) {
      const order = await this.shop.getOrder(fields.orderId);
      if (!order || order.customerId !== input.customerId) return notFound("order", fields.orderId);
      if (fields.type === "damaged_item") {
        const line = order.items.find((item) => item.productId === fields.productId);
        if (!line || fields.quantity > line.quantity) return invalidInput("productId", "Damaged quantity must belong to the customer's order");
      }
      if (fields.type === "address_change") {
        const valid = validateAddress(fields.address);
        if (!valid.ok) return valid;
      }
    }
    return success(fields);
  }
}

export class CreateRequest {
  constructor(private readonly deps: ShopDependencies) {}
  execute(input: CreateRequestInput): Promise<Result<Request>> {
    const parsed = createRequestInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve(invalidInput("request", "Invalid request intake"));
    return this.deps.shop.transaction(async (shop) => {
      const value = parsed.data;
      if (!await shop.getCustomer(value.customerId)) return notFound("customer", value.customerId);
      if (value.content.source === "structured") {
        const valid = await new ValidateRequestFields(shop).execute({ customerId: value.customerId, fields: value.content.fields });
        if (!valid.ok) return valid;
      }
      const requestId = parseShopId("request", await shop.nextSequentialId("request"));
      if (!requestId.ok) return requestId;
      const timestamp = this.deps.clock.now();
      if (!Number.isFinite(Date.parse(timestamp))) return invalidInput("clock", "Expected a valid timestamp");
      const createdAt = new Date(timestamp).toISOString();
      const request: Request = {
        id: requestId.value, customerId: value.customerId, subject: value.subject,
        orderId: value.content.source === "structured" && "orderId" in value.content.fields ? value.content.fields.orderId : null,
        content: value.content.source === "structured" ? value.content : { ...value.content, type: null },
        status: "open", tags: [], escalation: null, createdAt, updatedAt: createdAt,
      };
      await shop.createRequest(request);
      return success(request);
    });
  }
}
