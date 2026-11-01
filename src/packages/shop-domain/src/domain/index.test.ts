import { describe, expect, it } from "vitest";
import { SHOP_NAME } from "./index.js";

describe("shop-domain identity", () => {
  it("exports the product identity for consumers", () => {
    expect(SHOP_NAME).toBe("Kiln & Co.");
  });
});
