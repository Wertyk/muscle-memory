import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDbExec, getDbExec, withMigrationRuntime } from "@agent-native/core/db";
import {
  CreateReplacementOrder, Escalate, GenerateReturnLabel, GetShipmentStatus, GetRequestActivity,
  ID_PREFIXES, IssueRefund, REQUEST_TYPES, SendReply, SetRequestStatus, TagRequest,
  UpdateShippingAddress, invalidInput, parseShopId, requestType, success,
  type IdGenerator, type Order, type Refund, type Result,
} from "@muscle-memory/shop-domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type ShopDb } from "../db/index.js";
import { migrateShop } from "../db/migrations.js";
import * as tables from "../db/schema.js";
import { createShopDemoData, DEMO_NOW } from "../db/shop-demo-data.js";
import { resetShop, seedShop } from "./shop-demo-store.js";
import { DrizzleShopRepository } from "./shop-repository.js";

function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected fixture");
  return value;
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Unexpected shop error ${result.error.code}`);
  return result.value;
}

describe("shop persistence on local PGlite", () => {
  let directory: string;
  let db: ShopDb;
  let shop: DrizzleShopRepository;
  const fixtures = createShopDemoData(DEMO_NOW);
  const order = present(fixtures.orders[0]);
  const request = present(fixtures.requests[0]);
  const customer = present(fixtures.customers[0]);
  let counter = 9000;
  const ids: IdGenerator = { next: (kind) => `${ID_PREFIXES[kind]}_${++counter}` };
  const deps = () => ({ shop, ids, clock: { now: () => DEMO_NOW } });

  beforeAll(async () => {
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-shop-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => { await migrateShop(undefined); });
    db = getDb();
    shop = new DrizzleShopRepository(db);
  }, 30_000);
  beforeEach(async () => { await seedShop(db); });
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function snapshot() {
    return {
      customers: await db.select().from(tables.customers).orderBy(asc(tables.customers.id)),
      products: await db.select().from(tables.products).orderBy(asc(tables.products.id)),
      orders: await db.select().from(tables.orders).orderBy(asc(tables.orders.id)),
      shipments: await db.select().from(tables.shipments).orderBy(asc(tables.shipments.id)),
      requests: await shop.listRequests({}),
      refunds: await db.select().from(tables.refunds).orderBy(asc(tables.refunds.id)),
      replies: await db.select().from(tables.replies).orderBy(asc(tables.replies.id)),
    };
  }

  it("runs the named migration once and preserves existing data on reruns", async () => {
    const before = await snapshot();
    await withMigrationRuntime(async () => { await migrateShop(undefined); await migrateShop(undefined); });
    expect(await snapshot()).toEqual(before);
    const result = await getDbExec().execute("SELECT name FROM _muscle_memory_shop_migrations_named");
    expect(result.rows).toEqual([{ name: "task6-shop-tables" }]);
    // Simulate an interrupted application before its bookkeeping was recorded.
    await getDbExec().execute("DELETE FROM _muscle_memory_shop_migrations_named");
    await getDbExec().execute("DELETE FROM _muscle_memory_shop_migrations");
    await withMigrationRuntime(async () => { await migrateShop(undefined); });
    expect(await snapshot()).toEqual(before);
  });

  it("reads every entity and returns null for absent records", async () => {
    expect(await shop.getRequest(request.id)).toEqual(request);
    expect(await shop.getCustomer(customer.id)).toEqual(customer);
    expect(await shop.getProduct(present(fixtures.products[0]).id)).toEqual(fixtures.products[0]);
    expect(await shop.getOrder(order.id)).toEqual(order);
    expect(await shop.getShipmentForOrder(order.id)).toEqual(fixtures.shipments[0]);
    expect(await shop.listRefundsForOrder(present(fixtures.refunds[0]).orderId)).toEqual([fixtures.refunds[0]]);
    expect(await shop.getRequest("req_missing")).toBeNull();
    expect(await shop.getCustomer("cus_missing")).toBeNull();
    expect(await shop.getProduct("prd_missing")).toBeNull();
    expect(await shop.getOrder("ord_missing")).toBeNull();
    expect(await shop.getShipmentForOrder("ord_missing")).toBeNull();
    expect(await shop.listRefundsForOrder("ord_missing")).toEqual([]);
  });

  it("preserves purchased snapshots and detaches nested data across reads", async () => {
    const readOrder = present(await shop.getOrder(order.id));
    Object.assign(present(readOrder.items[0]).unitPrice, { amountMinor: 1 });
    Object.assign(readOrder.shippingAddress, { city: "Changed" });
    const readRequest = present(await shop.getRequest(request.id));
    Object.assign(readRequest.tags, { 0: "changed" });
    Object.assign(readRequest.content, { source: "free_text" });
    Object.assign(present(await shop.getCustomer(customer.id)).shippingAddress, { city: "Changed" });
    Object.assign(present(await shop.getProduct(present(fixtures.products[0]).id)).price, { amountMinor: 1 });
    Object.assign(present(await shop.getShipmentForOrder(order.id)), { carrier: "Changed" });
    Object.assign(present((await shop.listRefundsForOrder(present(fixtures.refunds[0]).orderId))[0]).amount, { amountMinor: 1 });
    await db.update(tables.products).set({ price: { amountMinor: 999, currency: "USD" } });
    expect(await shop.getOrder(order.id)).toEqual(order);
    expect(await shop.getRequest(request.id)).toEqual(request);
    expect(await shop.getCustomer(customer.id)).toEqual(customer);
    expect(await shop.getShipmentForOrder(order.id)).toEqual(fixtures.shipments[0]);
    expect(await shop.listRefundsForOrder(present(fixtures.refunds[0]).orderId)).toEqual([fixtures.refunds[0]]);
  });

  it("reads scoped activity from persisted replies/refunds/replacements/labels across repository instances", async () => {
    expect(await shop.getRequestActivityRecords("req_missing")).toBeNull();
    const read = () => new GetRequestActivity(new DrizzleShopRepository(db)).execute({ requestId: request.id }).then(value);
    const refund = value(await new IssueRefund(deps()).execute({ orderId: order.id, amount: { amountMinor: 1250, currency: "USD" }, reason: "Damage adjustment" }));
    expect(await read()).toContainEqual({ id: refund.id, at: refund.createdAt, kind: "refund", amount: refund.amount, reason: refund.reason });
    const reply = value(await new SendReply(deps()).execute({ requestId: request.id, template: "We have arranged your refund.", variables: {} }));
    expect(await read()).toContainEqual({ id: reply.id, at: reply.createdAt, kind: "reply", bodyExcerpt: reply.body });
    const replacement = value(await new CreateReplacementOrder(deps()).execute({ orderId: order.id }));
    const label = value(await new GenerateReturnLabel(deps()).execute({ orderId: order.id }));
    value(await new TagRequest(deps()).execute({ requestId: request.id, tag: "activity-check" }));
    value(await new SetRequestStatus(deps()).execute({ requestId: request.id, status: "pending" }));
    const events = await read();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "replacement", orderId: replacement.id }),
      expect.objectContaining({ kind: "return_label", labelId: label.id }),
      expect.objectContaining({ kind: "recorded_state", status: "pending", tags: expect.arrayContaining(["activity-check"]) }),
    ]));
    const unrelated = value(await new GetRequestActivity(shop).execute({ requestId: "req_0002" }));
    expect(unrelated.some(item => item.id === reply.id || item.id === refund.id || item.id === replacement.id)).toBe(false);
    const inquiry = fixtures.requests.find(item => item.orderId === null)!;
    const inquiryEvents = value(await new GetRequestActivity(shop).execute({ requestId: inquiry.id }));
    expect(inquiryEvents.every(item => item.kind === "request_received" || item.kind === "recorded_state")).toBe(true);
  });

  it("combines status, category, customer and exact tag filters for both request sources", async () => {
    const tagged = { ...request, tags: ["damage", "priority"] };
    await shop.saveRequest(tagged);
    await db.insert(tables.requests).values({ ...tagged, id: "req_free", content: { source: "free_text", text: "A chipped mug", type: "damaged_item" } });
    await db.insert(tables.requests).values({ ...tagged, id: "req_unknown", content: { source: "free_text", text: "Help please", type: null } });
    const filter = { status: "open", type: "damaged_item", customerId: customer.id, tag: "damage" } as const;
    expect((await shop.listRequests(filter)).map((r) => r.id)).toEqual([request.id, "req_free"]);
    expect(await shop.listRequests({ ...filter, status: "resolved" })).toEqual([]);
    expect(await shop.listRequests({ ...filter, type: "return" })).toEqual([]);
    expect(await shop.listRequests({ ...filter, customerId: "cus_missing" })).toEqual([]);
    expect(await shop.listRequests({ ...filter, tag: "dam" })).toEqual([]);
    expect(await shop.listRequests({ ...filter, tag: "Damage" })).toEqual([]);
    expect((await shop.listRequests({ tag: "damage" })).map((r) => r.id)).toContain("req_unknown");
    await shop.saveRequest({ ...tagged, content: { source: "free_text", type: "return", text: "Please return" } });
    expect((await shop.listRequests({ type: "return" })).map((r) => r.id)).toContain(request.id);
  });

  it("commits successful mutations through the domain entrypoints", async () => {
    const refund = value(await new IssueRefund(deps()).execute({ orderId: order.id, amount: { amountMinor: 100, currency: "USD" }, reason: "Demo damage" }));
    expect(await shop.listRefundsForOrder(order.id)).toEqual([refund]);
    const reply = value(await new SendReply(deps()).execute({ requestId: request.id, template: "Hello {{name}}", variables: { name: customer.name } }));
    expect(await db.select().from(tables.replies).where(eq(tables.replies.id, reply.id))).toEqual([reply]);
    value(await new TagRequest(deps()).execute({ requestId: request.id, tag: " handled " }));
    value(await new Escalate(deps()).execute({ requestId: request.id, reason: "Operator review" }));
    const resolved = value(await new SetRequestStatus(deps()).execute({ requestId: request.id, status: "resolved" }));
    expect(resolved.tags).toContain("handled");
    expect(resolved.escalation?.reason).toBe("Operator review");
    expect(await shop.getRequest(request.id)).toEqual(resolved);
    const replacement = value(await new CreateReplacementOrder(deps()).execute({ orderId: order.id }));
    expect(await shop.getOrder(replacement.id)).toEqual(replacement);
    expect(replacement.paid.amountMinor).toBe(0);
    const label = value(await new GenerateReturnLabel(deps()).execute({ orderId: order.id }));
    expect((await shop.getOrder(order.id))?.returnLabel).toEqual(label);
    expect(value(await new GenerateReturnLabel(deps()).execute({ orderId: order.id }))).toEqual(label);
  });

  it("rolls back all writes on typed errors and exceptions without rerunning callbacks", async () => {
    const before = await snapshot();
    const refund: Refund = { ...present(fixtures.refunds[0]), id: "ref_9001", orderId: order.id };
    let calls = 0;
    const result = await shop.transaction(async (records) => {
      calls++;
      await records.saveOrder({ ...order, shippingAddress: { ...order.shippingAddress, city: "Changed" } });
      await records.saveRequest({ ...request, status: "pending" });
      await records.createOrder({ ...order, id: "ord_9001", replacementForOrderId: order.id });
      await records.createRefund(refund);
      await records.createReply({ ...present(fixtures.replies[0]), id: "rpl_9001", requestId: request.id });
      return invalidInput("demo", "Abort");
    });
    expect(result).toEqual(invalidInput("demo", "Abort"));
    expect(calls).toBe(1);
    expect(await snapshot()).toEqual(before);
    const failure = new Error("Storage interrupted");
    await expect(shop.transaction(async (records) => {
      await records.createRefund(refund);
      throw failure;
    })).rejects.toBe(failure);
    expect(await snapshot()).toEqual(before);
  });

  it("enforces unique creates, foreign keys, short IDs and update-only saves", async () => {
    await expect(shop.createOrder(order)).rejects.toThrow();
    await expect(shop.createRefund(present(fixtures.refunds[0]))).rejects.toThrow();
    await expect(shop.createReply(present(fixtures.replies[0]))).rejects.toThrow();
    await expect(shop.createOrder({ ...order, id: "ord_new", customerId: "cus_missing" })).rejects.toThrow();
    await expect(shop.createOrder({ ...order, id: `ord_${"x".repeat(32)}` })).rejects.toThrow();
    await expect(shop.saveOrder({ ...order, id: "ord_missing" })).rejects.toThrow("missing order");
    await expect(shop.saveRequest({ ...request, id: "req_missing" })).rejects.toThrow("missing request");
    expect(await shop.getOrder("ord_missing")).toBeNull();
    expect(await shop.getRequest("req_missing")).toBeNull();
    if (request.content.source !== "structured") throw new Error("Expected structured fixture");
    await expect(db.insert(tables.requests).values({ ...request, id: "req_bad", orderId: "ord_1002" })).rejects.toThrow();
  });

  it("serializes competing refunds across repository instances without exceeding payment", async () => {
    const other = new DrizzleShopRepository(db);
    const amount = { amountMinor: Math.floor(order.paid.amountMinor * 0.75), currency: "USD" };
    const input = { orderId: order.id, amount, reason: "Concurrent damage refund" };
    const results = await Promise.all([
      new IssueRefund(deps()).execute(input),
      new IssueRefund({ ...deps(), shop: other }).execute(input),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: { code: "REFUND_EXCEEDS_BALANCE", availableMinor: order.paid.amountMinor - amount.amountMinor } });
    expect(await shop.listRefundsForOrder(order.id)).toHaveLength(1);
  });

  it("locks every shop table before invoking the mutation callback", async () => {
    await shop.transaction(async () => {
      const locks = await getDbExec().execute("SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.mode = 'ShareRowExclusiveLock' ORDER BY c.relname");
      expect(locks.rows.map((r: { relname: string }) => r.relname)).toEqual(["customers", "orders", "products", "refunds", "replies", "requests", "shipments"]);
      return success(null);
    });
  });

  it("serializes address changes with independent shipment dispatch and rejects later changes", async () => {
    const unshipped = present(fixtures.orders.find((o) => o.status === "unshipped"));
    const updated: Order = { ...unshipped, shippingAddress: { ...unshipped.shippingAddress, line1: "New Demo Lane" } };
    let readStarted!: () => void;
    const observedRead = new Promise<void>((resolve) => { readStarted = resolve; });
    const dispatch = (async () => {
      // This async context starts outside the transaction, so it cannot inherit
      // the framework's transaction-scoped connection.
      await observedRead;
      await db.update(tables.shipments).set({ status: "in_transit", shippedAt: DEMO_NOW }).where(eq(tables.shipments.orderId, unshipped.id));
    })();
    // Start an independent DB writer while the callback holds the transaction.
    const result = await shop.transaction(async (records) => {
      expect((await records.getShipmentForOrder(unshipped.id))?.status).toBe("pending");
      readStarted();
      await records.saveOrder(updated);
      return success(updated);
    });
    expect(result).toEqual(success(updated));
    await dispatch;
    expect((await shop.getShipmentForOrder(unshipped.id))?.status).toBe("in_transit");
    expect(await new UpdateShippingAddress(deps()).execute({ orderId: unshipped.id, address: unshipped.shippingAddress })).toEqual({ ok: false, error: { code: "ADDRESS_CHANGE_NOT_ALLOWED" } });
    expect(await shop.getOrder(unshipped.id)).toEqual(updated);
    // Shipment absent on an existing replacement differs from a missing order.
    await shop.createOrder({ ...unshipped, id: "ord_noship" });
    expect(value(await new GetShipmentStatus(shop).execute({ orderId: "ord_noship" })).shipment).toBeNull();
    expect(await new GetShipmentStatus(shop).execute({ orderId: "ord_missing" })).toEqual({ ok: false, error: { code: "NOT_FOUND", entity: "order", id: "ord_missing" } });
  });

  it("recreates identical data after mutations and retains non-shop records on reset/reseed", async () => {
    // A stand-in for framework/engine tables: neither maintenance command owns it.
    await getDbExec().execute("CREATE TABLE IF NOT EXISTS task6_unrelated (id TEXT PRIMARY KEY)");
    await getDbExec().execute("INSERT INTO task6_unrelated VALUES ('keep') ON CONFLICT DO NOTHING");
    const before = await snapshot();
    expect(before).toEqual({ ...fixtures, requests: [...fixtures.requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
    await shop.saveRequest({ ...request, status: "pending" });
    const counts = await seedShop(db);
    expect(counts).toEqual({ products: 25, customers: 40, orders: 61, shipments: 61, requests: 60, refunds: 9, replies: 30 });
    expect(await snapshot()).toEqual(before);
    await resetShop(db);
    expect(Object.values(await snapshot()).every((rows) => rows.length === 0)).toBe(true);
    expect((await getDbExec().execute("SELECT id FROM task6_unrelated")).rows).toEqual([{ id: "keep" }]);
    await resetShop(db);
    await seedShop(db);
    expect(await snapshot()).toEqual(before);
  });

  it("seeds actionable open cases and handled history for every category and source", async () => {
    const data = await snapshot();
    expect(data.requests.filter((r) => r.status === "open")).toHaveLength(30);
    for (const type of REQUEST_TYPES) {
      const open = data.requests.filter((r) => r.status === "open" && requestType(r) === type);
      expect(open).toHaveLength(6);
      expect(open.filter((r) => r.content.source === "structured")).toHaveLength(3);
      expect(open.filter((r) => r.content.source === "free_text")).toHaveLength(3);
      const history = data.requests.filter((r) => r.status === "resolved" && requestType(r) === type);
      expect(history).toHaveLength(type === "damaged_item" ? 10 : 5);
      expect(new Set(history.map((r) => r.content.source)).size).toBe(2);
      for (const handled of history) {
        expect(data.replies.some((r) => r.requestId === handled.id)).toBe(true);
        if (type === "damaged_item") {
          const refunded = data.refunds.some((r) => r.orderId === handled.orderId);
          const replaced = data.orders.some((o) => o.replacementForOrderId === handled.orderId);
          expect(refunded || replaced).toBe(true);
          expect(refunded && replaced).toBe(false);
        }
        if (type === "return") expect(data.orders.find((o) => o.id === handled.orderId)?.returnLabel).not.toBeNull();
      }
    }
    for (const item of data.orders) {
      expect(item.total.amountMinor).toBe(item.items.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0));
      expect(item.paid).toEqual(item.replacementForOrderId ? { amountMinor: 0, currency: "USD" } : item.total);
      expect(item.items.every((line) => data.products.some((p) => p.id === line.productId))).toBe(true);
      expect(data.shipments.filter((s) => s.orderId === item.id)).toHaveLength(1);
    }
    for (const item of data.requests) {
      expect(data.customers.some((c) => c.id === item.customerId)).toBe(true);
      expect(item.orderId === null || data.orders.some((o) => o.id === item.orderId && o.customerId === item.customerId)).toBe(true);
      if (item.content.source === "structured" && "orderId" in item.content.fields) expect(item.content.fields.orderId).toBe(item.orderId);
      if (requestType(item) === "address_change" && item.status === "open") {
        expect(data.orders.find((o) => o.id === item.orderId)?.status).toBe("unshipped");
      }
    }
    const entities = [data.customers, data.products, data.orders, data.shipments, data.requests, data.refunds, data.replies] as const;
    const kinds = ["customer", "product", "order", "shipment", "request", "refund", "reply"] as const;
    entities.forEach((rows, i) => rows.forEach((row) => expect(parseShopId(present(kinds[i]), row.id).ok).toBe(true)));
    expect(data.orders.filter((o) => o.returnLabel).every((o) => parseShopId("returnLabel", present(o.returnLabel).id).ok)).toBe(true);
    expect(data.customers.every((c) => /^[a-z]+\.[a-z]+@example\.(com|test)$/.test(c.email) && /^\d{5}$/.test(c.shippingAddress.postalCode))).toBe(true);
  });

  it("rolls back the entire reseed if a later insert fails", async () => {
    await shop.saveRequest({ ...request, status: "pending" });
    const before = await snapshot();
    await getDbExec().execute("CREATE FUNCTION task6_reject_reply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test insert failure'; END; $$");
    await getDbExec().execute("CREATE TRIGGER task6_reject_reply BEFORE INSERT ON replies FOR EACH ROW EXECUTE FUNCTION task6_reject_reply()");
    try {
      await expect(seedShop(db)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await getDbExec().execute("DROP TRIGGER task6_reject_reply ON replies");
      await getDbExec().execute("DROP FUNCTION task6_reject_reply()");
    }
  });
});
