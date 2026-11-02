import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { buildRequestTrigger, parseRecipeVersion, type Demonstration, type JsonObject, type TextExtractor } from "@muscle-memory/recipe-engine";
import { ValidateRequestFields, type Request } from "@muscle-memory/shop-domain";
import { asc, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import backtestRecipe from "../actions/backtest-recipe.js";
import compareVersions from "../actions/compare-recipe-versions.js";
import draftRecipe from "../actions/draft-recipe-from-demonstration.js";
import getDraft from "../actions/get-recipe-draft.js";
import updateDraft from "../actions/update-recipe-draft.js";
import saveVersion from "../actions/save-recipe-version.js";
import getOrder from "../actions/get-order.js";
import getCustomer from "../actions/get-customer.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import tagRequest from "../actions/tag-request.js";
import createReplacement from "../actions/create-replacement-order.js";
import { backtestOutputSchema, compareBacktestOutputSchema } from "./backtest-action-contracts.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import { createShopDemoData, DEMO_NOW } from "./db/shop-demo-data.js";
import { damagedItemBacktestFixture as recipe } from "./fixtures/backtest-recipes.js";
import { damagedItemFixture as blockedRecipe } from "./fixtures/intake-recipes.js";
import { runFixtures } from "./fixtures/run-recipes.js";
import { DrizzleRecipeCatalog } from "./infra/recipe-catalog.js";
import { seedShop } from "./infra/shop-demo-store.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { ShopHistoricalCaseSource } from "./infra/shop-historical-cases.js";
import { ShopRequestExtractor } from "./infra/shop-request-extractor.js";
import { CompleteTextExtractor } from "./infra/complete-text-extraction.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import { DrizzleTraceStore } from "./infra/trace-store.js";
import migrateApp from "./plugins/db.js";

const data = createShopDemoData(DEMO_NOW);
const historical = data.requests.filter((r) => r.status === "resolved");
const damages = historical.filter((r) => r.content.source === "structured" ? r.content.fields.type === "damaged_item" : r.content.type === "damaged_item");
const context = { caller: "frontend" as const, userEmail: "operator@example.test" };
// Core 0.222.2 retains the input schema at runtime but omits it from ActionDefinition.
const actionSchema = (action: object) => Reflect.get(action, "schema") as z.ZodType;

// Offline extraction fake only. Production always reads the original free text
// through ShopRequestExtractor; no seed-derived field oracle is installed.
function extracted(request: Request): JsonObject {
  if (request.content.source === "structured") return request.content.fields as unknown as JsonObject;
  const order = data.orders.find((o) => o.id === request.orderId);
  switch (request.content.type) {
    case "damaged_item": return { type: "damaged_item", orderId: order!.id, productId: order!.items[0]!.productId, quantity: 1, description: request.content.text };
    case "where_is_my_order": return { type: "where_is_my_order", orderId: order!.id };
    case "return": return { type: "return", orderId: order!.id, reason: request.content.text };
    case "address_change": return { type: "address_change", orderId: order!.id,
      ...Object.fromEntries(Object.entries(order!.shippingAddress).map(([k, v]) => [`address${k[0]!.toUpperCase()}${k.slice(1)}`, v])) };
    case "wholesale_inquiry": return { type: "wholesale_inquiry", company: "Synthetic cafe", message: request.content.text };
    default: throw new Error("Test fixture must have a classified type");
  }
}

describe("read-only historical recipe backtests on seeded PGlite", () => {
  let directory: string;
  let db: ShopDb;
  let sequence = 0;
  const extract = vi.fn<TextExtractor["extract"]>(async ({ text }) => {
    if (text === "Recipe extraction probe") return { output: { fraction: 0.5 }, tokens: { input: 2, output: 1 } };
    const request = historical.find((r) => r.content.source === "free_text" && r.content.text === text);
    if (!request) throw new Error("Unexpected test extraction");
    return { output: { ...extracted(request), ...(request.content.source === "free_text" && request.content.type === "damaged_item"
      ? { productMention: data.orders.find((o) => o.id === request.orderId)!.items[0]!.name } : {}) }, tokens: { input: 8, output: 4 } };
  });
  const registry = new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({
    "get-order": { default: getOrder }, "get-customer": { default: getCustomer },
    "issue-refund": { default: issueRefund }, "send-reply": { default: sendReply },
    "tag-request": { default: tagRequest }, "create-replacement-order": { default: createReplacement },
  }));
  const create = () => composition.createRecipeBacktests(db, { registry, context, extractor: { extract }, ids: { next: () => `run_backtest${++sequence}` } });
  const source = () => new ShopHistoricalCaseSource(db, (request) => new ShopRequestExtractor(
    { extract }, new ValidateRequestFields(new DrizzleShopRepository(db)), request.customerId,
  ));

  beforeAll(async () => {
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-backtests-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => { await migrateApp(undefined); });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await seedShop(db, { all: true });
    extract.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function shopSnapshot() {
    const snapshot: Record<string, unknown[]> = {};
    for (const [name, table] of Object.entries({
      customers: tables.customers, products: tables.products, orders: tables.orders,
      shipments: tables.shipments, requests: tables.requests, refunds: tables.refunds, replies: tables.replies,
    })) snapshot[name] = await db.select().from(table).orderBy(asc(table.id));
    return snapshot;
  }
  async function tableCounts() {
    const counts: Record<string, number> = {};
    for (const [name, table] of Object.entries(tables)) {
      const [row] = await db.select({ value: count() }).from(table);
      counts[name] = row!.value;
    }
    return counts;
  }

  it("reports 7 identical and the 3 deliberate deviations, readable reasons, tokens and zero writes (AC #1/#2/#4)", async () => {
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    const before = await shopSnapshot();
    const counts = await tableCounts();
    const invoke = vi.spyOn(registry, "invoke");
    const result = await backtestRecipe.run({ recipe, requestType: "damaged_item" }, context);
    expect(backtestOutputSchema.parse(result)).toEqual(result);
    expect(result.summary).toEqual({ total: 10, identical: 7, different: 3, notHandled: 0,
      tokens: { input: 40, output: 20 }, totalTokens: 60,
      requestExtractionTokens: { input: 40, output: 20 }, recipeExtractionTokens: { input: 0, output: 0 } });
    expect(result.cases.filter((c) => c.status === "different").map((c) => c.caseId).sort()).toEqual(["req_0038", "req_0039", "req_0040"]);
    const changed = (id: string) => result.cases.find((c) => c.caseId === id)!;
    expect(changed("req_0038").reasons.map((r) => r.message).join(" ")).toContain('historical "create-replacement-order"; recipe "issue-refund"');
    expect(changed("req_0039").diff).toContainEqual({ kind: "changed", path: "/0/input/amount/amountMinor", historical: 38000, intended: 19000 });
    expect(changed("req_0039").reasons.map((r) => r.message).join(" ")).toContain("38000; recipe 19000");
    expect(changed("req_0040").diff.some((d) => d.path === "/1/input/body")).toBe(true);
    expect(changed("req_0040").reasons.map((r) => r.message).join(" ")).toContain("packaging");
    expect(changed("req_0039").run?.steps.find((s) => s.stepId === "refund")).toMatchObject({ status: "planned", approvalRequired: true });
    expect(extract).toHaveBeenCalledTimes(5);
    for (const [input] of extract.mock.calls) {
      const request = historical.find((r) => r.content.source === "free_text" && r.content.text === input.text)!;
      const order = data.orders.find((o) => o.id === request.orderId)!;
      expect(input.context).toEqual({ orderId: order.id, lines: order.items.map(({ name, productId, quantity }) => ({
        name, sku: data.products.find((p) => p.id === productId)!.sku, productId, quantity,
      })) });
    }
    expect(new Set(invoke.mock.calls.map(([name]) => name))).toEqual(new Set(["get-order", "get-customer"]));
    expect(await tableCounts()).toEqual(counts);
    expect(await shopSnapshot()).toEqual(before);
    expect(result.readData).toBe("current");
  });

  it("selects only resolved/type-matching cases and builds exactly the intake trigger with action-shaped outcomes", async () => {
    const cases = await source().listCases({ event: "request.created", requestType: "damaged_item" });
    expect(cases).toHaveLength(10);
    for (const c of cases) {
      const request = damages.find((r) => r.id === c.id)!;
      expect(request.status).toBe("resolved");
      expect(c.trigger).toEqual(buildRequestTrigger(extracted(request), { requestId: request.id, customerId: request.customerId, subject: request.subject }));
      for (const mutation of c.outcome) {
        const definitions = { "issue-refund": issueRefund, "send-reply": sendReply, "tag-request": tagRequest, "create-replacement-order": createReplacement };
        expect(actionSchema(definitions[mutation.action as keyof typeof definitions]).safeParse(mutation.input).success).toBe(true);
        expect(mutation.input).not.toHaveProperty("id");
        expect(mutation.input).not.toHaveProperty("createdAt");
      }
    }
    expect(cases.find((c) => c.id === "req_0038")?.outcome[0]).toMatchObject({ action: "create-replacement-order", input: { orderId: "ord_1038", items: [{ quantity: 1 }] } });
  });

  it("backtests the Studio-saved approval fixture with a constant refund, approval gate and tag", async () => {
    const original = runFixtures.approval;
    const catalog = new DrizzleRecipeCatalog(db);
    await catalog.saveVersion(original);
    await catalog.save({ id: original.recipeId, name: original.name, status: "draft", activeVersionId: null });
    const draft = await getDraft.run({ recipeId: original.recipeId }, context);
    if (!draft || !("content" in draft)) throw new Error("Expected Studio draft");
    const updated = await updateDraft.run({ recipeId: original.recipeId, expectedRevision: draft.revision,
      content: { ...draft.content, trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, "damaged_item"] } } },
    }, context);
    const saved = await saveVersion.run({ recipeId: original.recipeId, expectedRevision: updated.revision }, context);
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    const before = await shopSnapshot();
    const counts = await tableCounts();
    const result = await backtestRecipe.run({ recipe: saved.id, requestType: "damaged_item" }, context);
    expect(backtestOutputSchema.parse(result)).toEqual(result);
    expect(result.summary).toMatchObject({ total: 10, identical: 0, different: 10, notHandled: 0 });
    for (const item of result.cases) {
      expect(item.run?.steps.find((step) => step.stepId === "refund")).toMatchObject({ status: "planned", approvalRequired: true,
        input: { amount: { amountMinor: 14000, currency: "USD" } } });
      expect(item.intendedMutations.map((mutation) => mutation.action)).toEqual(["issue-refund", "tag-request"]);
    }
    expect(await shopSnapshot()).toEqual(before);
    expect(await tableCounts()).toEqual(counts);
  });

  it("backtests an actual TASK-11 Teach draft against seed history without inventing fixture equivalence", async () => {
    const demo = JSON.parse(await readFile(new URL("./fixtures/broken-platter-demonstration.json", import.meta.url), "utf8")) as Demonstration;
    const actor = { ...context, userEmail: demo.scope.userId, orgId: demo.scope.workspaceId };
    await new DrizzleTraceStore(db).transaction((records) => records.save(demo));
    const drafted = await draftRecipe.run({ demonstrationId: demo.id }, actor);
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    const before = await shopSnapshot();
    const counts = await tableCounts();
    const result = await backtestRecipe.run({ recipe: drafted.draft.id, requestType: "damaged_item" }, actor);
    expect(result.summary).toMatchObject({ total: 10, identical: 0, different: 10, notHandled: 0, totalTokens: 60 });
    const fullRefund = result.cases.find((item) => item.caseId === "req_0039")!;
    expect(fullRefund.intendedMutations.find((mutation) => mutation.action === "issue-refund")?.input.amount).toEqual({ amountMinor: 19000, currency: "USD" });
    expect(fullRefund.diff).toContainEqual({ kind: "changed", path: "/0/input/amount/amountMinor", historical: 38000, intended: 19000 });
    expect(result.cases.every((item) => item.reasons.some((reason) => reason.code === "different"))).toBe(true);
    expect(await shopSnapshot()).toEqual(before);
    expect(await tableCounts()).toEqual(counts);
  });

  it("maps all 30 handled cases, including return labels, shipping-address outcomes and tags", async () => {
    let count = 0;
    for (const requestType of ["damaged_item", "where_is_my_order", "return", "address_change", "wholesale_inquiry"] as const) {
      const cases = await source().listCases({ event: "request.created", requestType });
      count += cases.length;
      expect(cases).toHaveLength(requestType === "damaged_item" ? 10 : 5);
      for (const c of cases) {
        if (requestType === "return") expect(c.outcome[0]?.action).toBe("generate-return-label");
        if (requestType === "address_change") expect(c.outcome[0]?.action).toBe("update-shipping-address");
        expect(c.outcome.filter((m) => m.action === "send-reply")).toHaveLength(1);
        expect(c.outcome.filter((m) => m.action === "tag-request").length).toBeGreaterThanOrEqual(2);
      }
    }
    expect(count).toBe(30);
  });

  it("bounds order-linked refunds/replacements by request handling time", async () => {
    const request = damages[0]!;
    await db.insert(tables.refunds).values({ id: "ref_9999", orderId: request.orderId!, amount: { amountMinor: 100, currency: "USD" }, reason: "Unrelated later outcome", createdAt: DEMO_NOW });
    const cases = await source().listCases({ event: "request.created", requestType: "damaged_item" });
    expect(cases.find((c) => c.id === request.id)?.outcome.filter((m) => m.action === "issue-refund")).toHaveLength(1);
  });

  it("compares a saved ID and unsaved snapshot on one extraction pass without persisting either report", async () => {
    await db.insert(tables.recipeVersions).values({ id: recipe.id, recipeId: recipe.recipeId, version: recipe.version, snapshot: recipe });
    const before = await tableCounts();
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    const candidate = parseRecipeVersion({ ...recipe, id: "ver_backtest_candidate", version: 2,
      steps: recipe.steps.map((s) => s.id === "reply" && s.kind === "action" ? { ...s, args: { ...s.args, template: { mode: "fixed", value: "A different reply" } } } : s) });
    const result = await compareVersions.run({ baseline: recipe.id, candidate, requestType: "damaged_item" }, context);
    expect(compareBacktestOutputSchema.parse(result)).toEqual(result);
    expect(result.baseline.summary).toMatchObject({ identical: 7, different: 3 });
    expect(result.candidate.summary).toMatchObject({ identical: 0, different: 10 });
    expect(result.cases.every((c) => c.changed)).toBe(true);
    expect(result.summary).toEqual({ tokens: { input: 40, output: 20 }, totalTokens: 60, sharedRequestExtractionTokens: { input: 40, output: 20 } });
    expect(extract).toHaveBeenCalledTimes(5);
    expect(await tableCounts()).toEqual(before);
    const unchanged = await create().compare({ baseline: recipe, candidate: recipe, requestType: "damaged_item" });
    expect(unchanged.cases.every((c) => !c.changed && c.diff.length === 0)).toBe(true);
  });

  it("adds actual recipe extract-step usage to intake usage, including invalid extraction output", async () => {
    const withExtract = parseRecipeVersion({ ...recipe, id: "ver_extract_probe", steps: [
      { id: "extracted", kind: "extract", text: { mode: "fixed", value: "Recipe extraction probe" }, fields: { fraction: { type: "number", required: true } } },
      ...recipe.steps,
    ] });
    const result = await create().execute({ recipe: withExtract, requestType: "damaged_item" });
    expect(result.summary).toMatchObject({ tokens: { input: 60, output: 30 }, totalTokens: 90, recipeExtractionTokens: { input: 20, output: 10 } });
    const comparison = await create().compare({ baseline: withExtract, candidate: withExtract, requestType: "damaged_item" });
    expect(comparison.summary).toMatchObject({ tokens: { input: 80, output: 40 }, totalTokens: 120 });
    const invalid = parseRecipeVersion({ ...withExtract, id: "ver_invalid_extract", steps: withExtract.steps.map((s) => s.kind === "extract" ? { ...s, fields: { fraction: { type: "string", required: true } } } : s) });
    const failed = await create().execute({ recipe: invalid, requestType: "damaged_item" });
    expect(failed.summary).toMatchObject({ notHandled: 10, totalTokens: 90 });
  });

  it("reports mutation-output dependencies as not_handled and never invents their results", async () => {
    const counts = await tableCounts();
    const result = await create().execute({ recipe: blockedRecipe, requestType: "damaged_item" });
    expect(result.summary).toMatchObject({ total: 10, identical: 0, different: 0, notHandled: 10 });
    expect(result.cases.every((c) => c.reasons.some((r) => r.code === "blocked"))).toBe(true);
    expect(await tableCounts()).toEqual(counts);
  });

  it("rejects missing versions, wrong events, bad cohorts and failed free-text extraction safely", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    const before = await tableCounts();
    await expect(backtestRecipe.run({ recipe: "ver_missing", requestType: "damaged_item" }, context)).rejects.toMatchObject({ errorCode: "VERSION_NOT_FOUND" });
    await expect(backtestRecipe.run({ recipe: { ...recipe, trigger: { ...recipe.trigger, event: "other.event" } }, requestType: "damaged_item" }, context)).rejects.toMatchObject({ errorCode: "INVALID_BACKTEST" });
    await expect(source().listCases({ event: "other.event", requestType: "damaged_item" })).rejects.toThrow();
    expect(actionSchema(backtestRecipe).safeParse({ recipe, requestType: "unknown" }).success).toBe(false);
    extract.mockResolvedValueOnce({ output: { type: "damaged_item" }, tokens: { input: 8, output: 4 } });
    await expect(backtestRecipe.run({ recipe, requestType: "damaged_item" }, context)).rejects.toMatchObject({ errorCode: "BACKTEST_FAILED",
      message: "Request req_0040 could not be reconstructed: free-text fields missing or invalid.",
    });
    expect(log).toHaveBeenLastCalledWith("[recipe-backtest]", expect.objectContaining({ requestId: "req_0040", name: "HistoricalReconstructionError" }));
    expect(await tableCounts()).toEqual(before);
    expect(backtestRecipe.readOnly).toBe(true);
    expect(compareVersions.readOnly).toBe(true);
    expect(backtestRecipe.http).toEqual({ method: "GET" });
    expect(compareVersions.http).toEqual({ method: "GET" });
  });

  it("preserves the actual extraction configuration failure through historical matching", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const complete = vi.fn();
    const extractor = new CompleteTextExtractor(() => ({ model: "" }), complete);
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => composition.createRecipeBacktests(db, { registry, context, extractor }));
    await expect(backtestRecipe.run({ recipe, requestType: "damaged_item" }, context)).rejects.toMatchObject({
      errorCode: "BACKTEST_FAILED", message: "Request req_0040 could not be reconstructed: Extraction is not configured. Set EXTRACT_MODEL and the provider credential.",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith("[recipe-backtest]", expect.objectContaining({ requestId: "req_0040", causeName: "ExtractionError" }));
  });

  it("keeps unknown historical extraction failures generic while logging the request without private details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(composition, "getRecipeBacktests").mockImplementation(() => create());
    extract.mockRejectedValueOnce(new TypeError("private provider/customer text"));
    await expect(backtestRecipe.run({ recipe, requestType: "damaged_item" }, context)).rejects.toMatchObject({
      errorCode: "BACKTEST_FAILED", message: "Backtest could not finish. Check the historical request fields and recipe, then retry.",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith("[recipe-backtest]", {
      name: "HistoricalReconstructionError", message: "Unexpected historical reconstruction failure (private details withheld).", requestId: "req_0040",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider/customer text");
  });

  it("uses current read data without modifying stored history", async () => {
    const request = damages.find((r) => r.content.source === "structured")!;
    const order = data.orders.find((o) => o.id === request.orderId)!;
    await db.update(tables.orders).set({ items: order.items.map((item, index) => index === 0 ? { ...item, unitPrice: { ...item.unitPrice, amountMinor: item.unitPrice.amountMinor + 200 } } : item) }).where(eq(tables.orders.id, order.id));
    const before = await shopSnapshot();
    const result = await create().execute({ recipe, requestType: "damaged_item" });
    expect(result.summary).toMatchObject({ identical: 6, different: 4 });
    expect(result.cases.find((c) => c.caseId === request.id)?.diff.some((d) => d.path.includes("amountMinor"))).toBe(true);
    expect(await shopSnapshot()).toEqual(before);
  });
});
