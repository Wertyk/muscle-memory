import type { ExtractField, JsonObject, RequestExtractor, TextExtractor } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, structuredRequestFieldsSchema, type CustomerId, type OrderId, type ShopRecords, type ValidateRequestFields } from "@muscle-memory/shop-domain";
import { z } from "zod";

const strings = ["orderId", "productId", "productMention", "description", "reason", "company", "message",
  "addressName", "addressLine1", "addressLine2", "addressCity", "addressRegion", "addressPostalCode", "addressCountryCode"] as const;
const optional = Object.fromEntries(strings.map((name) => [name, z.string().optional()])) as Record<typeof strings[number], z.ZodOptional<z.ZodString>>;
const flatSchema = z.object({ type: z.enum(REQUEST_TYPES), quantity: z.number().int().positive().optional(), ...optional }).strict();
export const requestExtractionFields: Readonly<Record<string, ExtractField>> = {
  type: { type: "string", required: true, description: `One of ${REQUEST_TYPES.join(", ")}; use only a supported type. Do not infer IDs or invent missing information.` },
  quantity: { type: "number", required: false, description: "Explicit damaged quantity in words or digits, converted to a positive integer; omit if absent. Never use the order line quantity as the damaged quantity." },
  ...Object.fromEntries(strings.map((name) => [name, { type: "string" as const, required: false, description: `${name}: copy only information present in the message; omit if absent. Address fields describe the NEW delivery address.` }])),
  orderId: { type: "string", required: false, description: "Use context.orderId if supplied; otherwise copy an explicit order ID from sourceText. Never invent an ID." },
  productId: { type: "string", required: false, description: "For damaged_item, select only the context.lines productId uniquely identified by the customer's product name or SKU in sourceText. Omit if ambiguous or no product is named. Without context, copy only an explicit product ID." },
  productMention: { type: "string", required: false, description: "For damaged_item, copy the exact product name or SKU phrase from sourceText (only the identifying words, no surrounding sentence). Required when selecting a context.lines productId. Omit if absent or ambiguous; never copy a name from context that is not in sourceText." },
};

const words = (value: string) => value.toLowerCase().match(/[a-z0-9_]+/g)?.map((word) => word.replace(/s$/, "")) ?? [];

/** Flatten primitives only at the TextExtractor boundary, then recover the exact
 * shop discriminated union. Missing required fields fail closed, never get defaults. */
export class ShopRequestExtractor implements RequestExtractor {
  constructor(private readonly text: TextExtractor, private readonly validator: ValidateRequestFields, private readonly customerId: CustomerId,
    private readonly linked?: { readonly orderId: OrderId | null; readonly shop: Pick<ShopRecords, "getOrder" | "getProduct"> }) {}
  async extract(text: string) {
    // New intake has no stored link yet. Resolve only one explicit reference,
    // never search or offer the customer's other orders to the model.
    const references = [...new Set(text.match(/\bord_[a-z0-9]+\b/g) ?? [])];
    const orderId = this.linked?.orderId ?? (references.length === 1 ? references[0] as OrderId : null);
    const order = orderId ? await this.linked?.shop.getOrder(orderId) : null;
    const context = order?.customerId === this.customerId ? {
      orderId: order.id,
      lines: await Promise.all(order.items.map(async ({ name, productId, quantity }) => ({
        name, sku: (await this.linked!.shop.getProduct(productId))?.sku ?? null, productId, quantity,
      }))),
    } : undefined;
    const result = await this.text.extract({ text, fields: requestExtractionFields, ...(context ? { context } : {}) });
    const parsed = flatSchema.safeParse(result.output);
    if (!parsed.success) return { fields: null, tokens: result.tokens };
    const flat = parsed.data;
    if (this.linked && "orderId" in flat && flat.orderId !== undefined && orderId && flat.orderId !== orderId)
      return { fields: null, tokens: result.tokens };
    if (context && flat.type === "damaged_item") {
      const mention = flat.productMention?.trim();
      const tokens = words(mention ?? "");
      const matches = mention && text.toLowerCase().includes(mention.toLowerCase()) && tokens.length && tokens.every((token) => words(text).includes(token))
        ? context.lines.filter((line) => line.productId === mention || line.sku?.toLowerCase() === mention.toLowerCase()
          || tokens.every((token) => words(line.name).includes(token))) : [];
      if (matches.length !== 1 || matches[0]!.productId !== flat.productId)
        return { fields: null, tokens: result.tokens };
    }
    let candidate: unknown;
    switch (flat.type) {
      case "damaged_item": candidate = { type: flat.type, orderId: flat.orderId, productId: flat.productId, quantity: flat.quantity, description: flat.description }; break;
      case "where_is_my_order": candidate = { type: flat.type, orderId: flat.orderId }; break;
      case "return": candidate = { type: flat.type, orderId: flat.orderId, reason: flat.reason }; break;
      case "wholesale_inquiry": candidate = { type: flat.type, company: flat.company, message: flat.message }; break;
      case "address_change": candidate = { type: flat.type, orderId: flat.orderId, address: {
        name: flat.addressName, line1: flat.addressLine1, ...(flat.addressLine2 === undefined ? {} : { line2: flat.addressLine2 }),
        city: flat.addressCity, region: flat.addressRegion, postalCode: flat.addressPostalCode, countryCode: flat.addressCountryCode,
      } }; break;
    }
    const fields = structuredRequestFieldsSchema.safeParse(candidate);
    if (!fields.success) return { fields: null, tokens: result.tokens };
    const valid = await this.validator.execute({ customerId: this.customerId, fields: fields.data });
    return { fields: valid.ok ? valid.value as unknown as JsonObject : null, tokens: result.tokens };
  }
}
