/** Shop query classification shared by capture and its presentation. Keep this
 * aligned with the readOnly/GET action metadata (checked by shop-actions tests). */
export const SHOP_LOOKUP_ACTIONS = [
  "list-requests",
  "get-request",
  "get-order",
  "get-customer",
  "get-shipment-status",
  "get-request-activity",
] as const;

export function isShopLookup(action: string): boolean {
  return SHOP_LOOKUP_ACTIONS.some((name) => name === action);
}
