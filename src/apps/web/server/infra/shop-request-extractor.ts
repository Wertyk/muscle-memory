import type { ExtractField, JsonObject, RequestExtractor, TextExtractor } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, structuredRequestFieldsSchema, type CustomerId, type ValidateRequestFields } from "@muscle-memory/shop-domain";
import { z } from "zod";

const strings = ["orderId", "productId", "description", "reason", "company", "message",
  "addressName", "addressLine1", "addressLine2", "addressCity", "addressRegion", "addressPostalCode", "addressCountryCode"] as const;
const optional = Object.fromEntries(strings.map((name) => [name, z.string().optional()])) as Record<typeof strings[number], z.ZodOptional<z.ZodString>>;
const flatSchema = z.object({ type: z.enum(REQUEST_TYPES), quantity: z.number().int().positive().optional(), ...optional }).strict();
export const requestExtractionFields: Readonly<Record<string, ExtractField>> = {
  type: { type: "string", required: true, description: `One of ${REQUEST_TYPES.join(", ")}; use only a supported type. Do not infer IDs or invent missing information.` },
  quantity: { type: "number", required: false, description: "Explicit damaged quantity, a positive integer; omit if absent" },
  ...Object.fromEntries(strings.map((name) => [name, { type: "string" as const, required: false, description: `${name}: copy only information present in the message; omit if absent. Address fields describe the NEW delivery address.` }])),
};

/** Flatten primitives only at the TextExtractor boundary, then recover the exact
 * shop discriminated union. Missing required fields fail closed, never get defaults. */
export class ShopRequestExtractor implements RequestExtractor {
  constructor(private readonly text: TextExtractor, private readonly validator: ValidateRequestFields, private readonly customerId: CustomerId) {}
  async extract(text: string) {
    const result = await this.text.extract({ text, fields: requestExtractionFields });
    const parsed = flatSchema.safeParse(result.output);
    if (!parsed.success) return { fields: null, tokens: result.tokens };
    const flat = parsed.data;
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
