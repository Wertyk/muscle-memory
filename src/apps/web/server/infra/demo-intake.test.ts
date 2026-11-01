import { ValidateRequestFields } from "@muscle-memory/shop-domain";
import { describe, expect, it } from "vitest";
import { createShopDemoData, DEMO_NOW } from "../db/shop-demo-data.js";
import { demoIntakeScript } from "./demo-intake.js";

describe("scripted incoming customer requests", () => {
  const seed = createShopDemoData(DEMO_NOW);
  it("uses varied seeded fictional customers and natural text without disclosure words", () => {
    expect(demoIntakeScript).toHaveLength(5);
    expect(JSON.stringify(demoIntakeScript)).not.toMatch(/demo|synthetic/i);
    expect(new Set(demoIntakeScript.map(request => request.customerId)).size).toBe(5);
    expect(new Set(demoIntakeScript.map(request => request.subject)).size).toBe(5);
    for (const request of demoIntakeScript) {
      const customer = seed.customers.find(row => row.id === request.customerId);
      expect(customer).toBeDefined();
      expect(JSON.stringify(request.content)).toContain(customer!.name.split(" ")[0]);
    }
  });
  it("keeps the scripted structured fields valid for each existing customer's order", async () => {
    const validator = new ValidateRequestFields({
      getCustomer: async id => seed.customers.find(row => row.id === id) ?? null,
      getOrder: async id => seed.orders.find(row => row.id === id) ?? null,
    });
    for (const request of demoIntakeScript) {
      if (request.content.source === "structured") {
        expect((await validator.execute({ customerId: request.customerId, fields: request.content.fields })).ok).toBe(true);
      }
    }
  });
});
