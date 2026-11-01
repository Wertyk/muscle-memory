import { invalidInput, success, type Result } from "./result.js";

export const ID_PREFIXES = {
  customer: "cus", product: "prd", order: "ord", shipment: "shp",
  request: "req", refund: "ref", reply: "rpl", returnLabel: "lbl",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type ShopId<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;
export type CustomerId = ShopId<"customer">;
export type ProductId = ShopId<"product">;
export type OrderId = ShopId<"order">;
export type ShipmentId = ShopId<"shipment">;
export type RequestId = ShopId<"request">;
export type RefundId = ShopId<"refund">;
export type ReplyId = ShopId<"reply">;
export type ReturnLabelId = ShopId<"returnLabel">;

/** At most 31 characters: the framework audit log redacts 32+ character tokens. */
export function parseShopId<K extends IdKind>(kind: K, value: string): Result<ShopId<K>> {
  return value.length <= 31 && new RegExp(`^${ID_PREFIXES[kind]}_[a-z0-9]+$`).test(value)
    ? success(value as ShopId<K>)
    : invalidInput("id", `Expected a short ${ID_PREFIXES[kind]}_ identifier`);
}
