export type ShopError =
  | { readonly code: "NOT_FOUND"; readonly entity: string; readonly id: string }
  | { readonly code: "INVALID_INPUT"; readonly field: string; readonly message: string }
  | { readonly code: "CURRENCY_MISMATCH"; readonly expected: string; readonly actual: string }
  | { readonly code: "REFUND_EXCEEDS_BALANCE"; readonly availableMinor: number }
  | { readonly code: "RETURN_WINDOW_EXPIRED"; readonly days: number }
  | { readonly code: "ORDER_NOT_DELIVERED" }
  | { readonly code: "ORDER_CANCELLED" }
  | { readonly code: "ADDRESS_CHANGE_NOT_ALLOWED" }
  | { readonly code: "MISSING_TEMPLATE_VARIABLE"; readonly variable: string };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ShopError };

export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (error: ShopError): Result<never> => ({ ok: false, error });
export const invalidInput = (field: string, message: string): Result<never> =>
  failure({ code: "INVALID_INPUT", field, message });
export const notFound = (entity: string, id: string): Result<never> =>
  failure({ code: "NOT_FOUND", entity, id });
