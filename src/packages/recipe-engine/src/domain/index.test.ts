import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "./index.js";

describe("recipe-engine identity", () => {
  it("exports the product identity for consumers", () => {
    expect(PRODUCT_NAME).toBe("Muscle Memory");
  });
});
