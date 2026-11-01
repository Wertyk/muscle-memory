import { isWithinAutoRefundLimit, requestType, type Request } from "@muscle-memory/shop-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShopDemoData, DEMO_NOW, shopDemoAnchor } from "./shop-demo-data.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture");
  return value;
}

describe("rehearsal fixtures", () => {
  const data = createShopDemoData(DEMO_NOW);
  const orderFor = (request: Request) => present(data.orders.find((order) => order.id === request.orderId));
  const replyFor = (request: Request) => present(data.replies.find((reply) => reply.requestId === request.id));
  const damagedHistory = data.requests.filter((r) => r.status === "resolved" && requestType(r) === "damaged_item");
  const historyCase = (id: Request["id"]) => present(damagedHistory.find((r) => r.id === id));

  it("recreates identical data with the fixed seed and dates", () => {
    expect(createShopDemoData(DEMO_NOW)).toEqual(data);
    expect(createShopDemoData(DEMO_NOW)).toEqual(data);
  });

  it("anchors default data to the current seeding minute and accepts a fixed rehearsal anchor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T18:30:47.987Z"));
    vi.stubEnv("SHOP_DEMO_ANCHOR", undefined);
    expect(shopDemoAnchor()).toBe("2026-11-08T18:30:00.000Z");
    expect(createShopDemoData()).toEqual(createShopDemoData("2026-11-08T18:30:00Z"));
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    expect(createShopDemoData()).toEqual(data);
    vi.stubEnv("SHOP_DEMO_ANCHOR", "invalid");
    expect(() => createShopDemoData()).toThrow("SHOP_DEMO_ANCHOR");
  });

  it("shifts every timestamp by exactly the anchor difference without changing any other content", () => {
    const anchor = "2026-11-08T17:43:59.999Z";
    const delta = Date.parse(shopDemoAnchor(anchor)) - Date.parse(DEMO_NOW);
    const shift = (value: unknown): unknown => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(Date.parse(value) + delta).toISOString();
      if (Array.isArray(value)) return value.map(shift);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)]));
      return value;
    };
    expect(createShopDemoData(anchor)).toEqual(shift(data));
  });

  it("uses fictional-looking contacts and addresses without disclosure words in customer-facing data", () => {
    // Check all stored strings, including nested addresses, tags, SKUs, and templates.
    expect(JSON.stringify(data)).not.toMatch(/demo|synthetic/i);
    expect(new Set(data.customers.map((c) => c.name)).size).toBe(40);
    for (const customer of data.customers) {
      expect(customer.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(customer.email).toMatch(/^[a-z]+\.[a-z]+@example\.(com|test)$/);
      const address = customer.shippingAddress;
      expect(address.name).toBe(customer.name);
      expect(address.line1).toMatch(/^\d+ [A-Z][a-z]+/);
      expect(address.postalCode).toMatch(/^\d{5}$/);
      expect(["OR", "CO", "NC", "WA", "VT"]).toContain(address.region);
      expect(address.countryCode).toBe("US");
    }
    expect(new Set(data.customers.map((c) => c.shippingAddress.city)).size).toBe(5);
  });

  it("includes four wording variants per category and source and varied purchases", () => {
    for (const type of ["damaged_item", "where_is_my_order", "return", "address_change", "wholesale_inquiry"] as const) {
      for (const source of ["structured", "free_text"] as const) {
        const requests = data.requests.filter((r) => requestType(r) === type && r.content.source === source);
        expect(new Set(requests.map((r) => r.subject)).size).toBe(4);
        const prose = requests.flatMap((r) => {
          if (r.content.source === "free_text") return [r.content.text];
          const fields = r.content.fields;
          if (fields.type === "damaged_item") return [fields.description];
          if (fields.type === "return") return [fields.reason];
          if (fields.type === "wholesale_inquiry") return [fields.message];
          return []; // Lookup and address forms have no prose field in the domain contract.
        });
        if (prose.length) expect(new Set(prose).size).toBeGreaterThanOrEqual(4);
      }
    }
    expect(new Set(data.orders.map((o) => o.items.length)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(data.orders.flatMap((o) => o.items.map((line) => line.quantity))).size).toBeGreaterThanOrEqual(3);
    expect(new Set(data.requests.filter((r) => requestType(r) === "damaged_item").map((r) => present(orderFor(r).items[0]).productId)).size).toBeGreaterThanOrEqual(4);
  });

  it("pins an open damaged platter whose half-unit refund exceeds the approval threshold", () => {
    const request = present(data.requests.find((r) => r.id === "req_0001"));
    expect(request.status).toBe("open");
    expect(request.content.source).toBe("structured");
    expect(requestType(request)).toBe("damaged_item");
    const line = present(orderFor(request).items.find((item) => request.content.source === "structured"
      && request.content.fields.type === "damaged_item" && item.productId === request.content.fields.productId));
    expect(line.name).toBe("Ember Large Serving Platter");
    expect(line.unitPrice.amountMinor).toBe(28000);
    const refund = { ...line.unitPrice, amountMinor: Math.floor(line.unitPrice.amountMinor / 2) };
    expect(refund.amountMinor).toBe(14000);
    expect(isWithinAutoRefundLimit(refund)).toBe(false);
    expect(data.products.filter((p) => p.price.amountMinor >= 21000 && p.price.amountMinor <= 38000)).toHaveLength(5);
  });

  it("stores seven standard damaged-item outcomes and three distinct backtest deviations", () => {
    expect(damagedHistory).toHaveLength(10);
    const standardTemplate = replyFor(historyCase("req_0031")).template;
    let standardCount = 0;
    for (const request of damagedHistory) {
      const order = orderFor(request);
      const refunds = data.refunds.filter((r) => r.orderId === order.id);
      const replacements = data.orders.filter((o) => o.replacementForOrderId === order.id);
      const reply = replyFor(request);
      expect(request.tags).toContain("damaged_item");
      expect(request.tags).toContain("handled");
      if (refunds.length === 1 && present(refunds[0]).amount.amountMinor === Math.floor(present(order.items[0]).unitPrice.amountMinor / 2)
        && replacements.length === 0 && reply.template === standardTemplate) standardCount++;
    }
    expect(standardCount).toBe(7);

    const replaced = historyCase("req_0038");
    const original = orderFor(replaced);
    const replacement = present(data.orders.find((o) => o.replacementForOrderId === original.id));
    expect(data.refunds.filter((r) => r.orderId === original.id)).toHaveLength(0);
    expect(replacement.id).toBe("ord_1061");
    expect(replacement.paid).toEqual({ amountMinor: 0, currency: "USD" });
    expect(replacement.items).toEqual([{ ...present(original.items[0]), quantity: 1 }]);
    expect(replacement.total).toEqual(present(original.items[0]).unitPrice);
    expect(replacement.shippingAddress).toEqual(original.shippingAddress);
    expect(replacement.customerId).toBe(original.customerId);
    expect(replacement.createdAt).toBe(replaced.updatedAt);
    expect(replacement.status).toBe("unshipped");
    expect(data.shipments.find((s) => s.orderId === replacement.id)?.status).toBe("pending");
    expect(replyFor(replaced).body).toContain(replacement.id);
    expect(replaced.tags).toContain("replacement");

    const fullyRefunded = historyCase("req_0039");
    const fullOrder = orderFor(fullyRefunded);
    const fullRefund = present(data.refunds.find((r) => r.orderId === fullOrder.id));
    expect(fullRefund.amount.amountMinor).toBe(38000);
    expect(fullRefund.amount).toEqual(fullOrder.paid);
    expect(fullRefund.amount).toEqual(present(fullOrder.items[0]).unitPrice);
    expect(replyFor(fullyRefunded).body).toContain("full USD 380.00");

    const differentReply = historyCase("req_0040");
    const partialRefund = present(data.refunds.find((r) => r.orderId === differentReply.orderId));
    expect(partialRefund.amount.amountMinor).toBe(Math.floor(present(orderFor(differentReply).items[0]).unitPrice.amountMinor / 2));
    expect(replyFor(differentReply).template).not.toBe(standardTemplate);
    expect(replyFor(differentReply).body).toContain("review the packaging");
  });

  it("keeps persisted historical replies, amounts and timestamps consistent with their requests", () => {
    for (const reply of data.replies) {
      const request = present(data.requests.find((r) => r.id === reply.requestId));
      const customer = present(data.customers.find((c) => c.id === request.customerId));
      expect(reply.customerId).toBe(customer.id);
      expect(reply.to).toBe(customer.email);
      expect(reply.createdAt).toBe(request.updatedAt);
      expect(reply.body).toBe(reply.template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(reply.variables[key])));
      const refund = data.refunds.find((r) => r.orderId === request.orderId);
      if (refund) {
        expect(refund.createdAt).toBe(request.updatedAt);
        expect(refund.amount.amountMinor).toBeLessThanOrEqual(orderFor(request).paid.amountMinor);
        expect(reply.body).toContain(`USD ${(refund.amount.amountMinor / 100).toFixed(2)}`);
      }
    }
  });

  it("spreads inbox ages over three days and keeps varied history in chronological order", () => {
    const now = Date.parse(DEMO_NOW);
    const day = 24 * 60 * 60 * 1000;
    const open = data.requests.filter((r) => r.status === "open");
    const history = data.requests.filter((r) => r.status === "resolved");
    expect(new Set(open.map((r) => r.createdAt)).size).toBe(30);
    expect(new Set(open.map((r) => r.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...open.map((r) => now - Date.parse(r.createdAt)))).toBeGreaterThan(2.5 * day);
    for (const request of open) {
      expect(now - Date.parse(request.createdAt)).toBeGreaterThan(0);
      expect(now - Date.parse(request.createdAt)).toBeLessThanOrEqual(3 * day);
      expect(request.updatedAt).toBe(request.createdAt);
    }
    expect(new Set(history.map((r) => r.createdAt)).size).toBe(30);
    expect(new Set(history.map((r) => r.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(15);
    for (const request of history) {
      expect(Date.parse(request.createdAt)).toBeLessThan(now - 3 * day);
      expect(Date.parse(request.updatedAt)).toBeGreaterThan(Date.parse(request.createdAt));
      expect(Date.parse(request.updatedAt)).toBeLessThan(now);
    }
    for (const request of data.requests.filter((r) => r.orderId !== null)) {
      const order = orderFor(request);
      expect(Date.parse(order.createdAt)).toBeLessThan(Date.parse(request.createdAt));
      if (order.deliveredAt) expect(Date.parse(order.deliveredAt)).toBeLessThan(Date.parse(request.createdAt));
      if (order.returnLabel) {
        expect(order.returnLabel.createdAt).toBe(request.updatedAt);
        expect(Date.parse(order.returnLabel.createdAt) - Date.parse(present(order.deliveredAt))).toBeLessThanOrEqual(30 * day);
      }
    }
    for (const shipment of data.shipments) {
      const order = present(data.orders.find((o) => o.id === shipment.orderId));
      if (shipment.shippedAt) expect(Date.parse(shipment.shippedAt)).toBeGreaterThan(Date.parse(order.createdAt));
      if (shipment.deliveredAt) expect(Date.parse(shipment.deliveredAt)).toBeGreaterThan(Date.parse(present(shipment.shippedAt)));
    }
  });
});
