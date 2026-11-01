import { failure, invalidInput, success, type Result } from "./result.js";

/** Integer minor units (cents for USD); no floating point monetary arithmetic. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export function money(amountMinor: number, currency = "USD"): Result<Money> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return invalidInput("amountMinor", "Expected non-negative safe integer minor units");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return invalidInput("currency", "Expected a three-letter uppercase currency code");
  }
  return success({ amountMinor, currency });
}

export function addMoney(left: Money, right: Money): Result<Money> {
  if (left.currency !== right.currency) {
    return failure({ code: "CURRENCY_MISMATCH", expected: left.currency, actual: right.currency });
  }
  const validLeft = money(left.amountMinor, left.currency);
  if (!validLeft.ok) return validLeft;
  const validRight = money(right.amountMinor, right.currency);
  return validRight.ok ? money(left.amountMinor + right.amountMinor, left.currency) : validRight;
}
