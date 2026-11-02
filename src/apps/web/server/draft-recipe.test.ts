import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadActionsFromStaticRegistry, runWithRequestContext } from "@agent-native/core/server";
import { buildRequestTrigger, expressionPaths, inferBindings, MatchRequest, type ActionStep, type Demonstration, type JsonObject, type RecipeDraft } from "@muscle-memory/recipe-engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import draftAction from "../actions/draft-recipe-from-demonstration.js";
import getDraft from "../actions/get-recipe-draft.js";
import start from "../actions/start-demonstration.js";
import stop from "../actions/stop-demonstration.js";
import cancel from "../actions/cancel-demonstration.js";
import getRequest from "../actions/get-request.js";
import getOrder from "../actions/get-order.js";
import getShipment from "../actions/get-shipment-status.js";
import getCustomer from "../actions/get-customer.js";
import getActivity from "../actions/get-request-activity.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import tag from "../actions/tag-request.js";
import runRecipe from "../actions/run-recipe.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import { createShopDemoData, DEMO_NOW } from "./db/shop-demo-data.js";
import { recipeDraftSchema } from "./draft-action-contracts.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { DrizzleRecipeCatalog } from "./infra/recipe-catalog.js";
import { seedShop } from "./infra/shop-demo-store.js";
import { DrizzleTraceStore } from "./infra/trace-store.js";
import migrate from "./plugins/db.js";

const data = createShopDemoData(DEMO_NOW);
const request = data.requests[0]!;
const order = data.orders.find(item => item.id === request.orderId)!;
const customer = data.customers.find(item => item.id === request.customerId)!;
const target = data.requests.find(item => item.id !== request.id && item.status === "open" && item.content.source === "structured" && item.content.fields.type === "damaged_item" && data.orders.some(order => order.id === item.orderId && order.items.length > 1 && order.items[0]!.unitPrice.amountMinor !== order.items[1]!.unitPrice.amountMinor))!;
const targetOrder = data.orders.find(item => item.id === target.orderId)!;
const targetCustomer = data.customers.find(item => item.id === target.customerId)!;
const context = { caller: "frontend" as const, userEmail: "operator@example.test" };
function session<T>(work: () => Promise<T>) {
  return runWithRequestContext({ userEmail: context.userEmail, orgId: "shop", run: { browserTabId: "draft_tab" } }, work);
}
const actionStep = (result: RecipeDraft, name: string) => result.draft.steps.find(step => step.kind === "action" && step.action === name) as ActionStep;

describe("stored Teach → draft → dry-run with real app actions", () => {
  let directory: string;
  let db: ShopDb;
  let runSequence = 0;
  const extract = vi.fn(async (): Promise<never> => { throw new Error("No LLM permitted"); });
  const registry = new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({
    "get-request": { default: getRequest }, "get-order": { default: getOrder }, "get-shipment-status": { default: getShipment },
    "get-customer": { default: getCustomer }, "get-request-activity": { default: getActivity },
    "issue-refund": { default: issueRefund }, "send-reply": { default: sendReply }, "tag-request": { default: tag },
  }));
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-draft-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    await withMigrationRuntime(async () => { await migrate(undefined); });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await seedShop(db, { all: true });
    extract.mockClear();
    vi.spyOn(composition, "getDraftRecipeUseCases").mockImplementation(() => composition.createDraftRecipeUseCases(db, registry));
    vi.spyOn(composition, "getRecipeUseCases").mockImplementation(() => composition.createRecipeUseCases(db, { registry, context, extractor: { extract }, ids: { next: () => `run_draft${++runSequence}` } }));
    await session(() => writeAppStateForCurrentTab("navigation", { view: "request", requestId: request.id, path: `/requests/${request.id}` }));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function record(literalReply = false) {
    const demonstration = await start.run({ requestId: request.id }, context);
    await getRequest.run({ requestId: request.id }, context);
    await getOrder.run({ orderId: order.id }, context);
    await getShipment.run({ orderId: order.id }, context);
    await getCustomer.run({ customerId: customer.id }, context);
    await getActivity.run({ requestId: request.id }, context);
    await issueRefund.run({ orderId: order.id, amount: { amountMinor: 14000, currency: "USD" }, reason: "Damaged item" }, context);
    await sendReply.run({ requestId: request.id,
      template: literalReply ? `Hi ${customer.name}, we refunded 14000 minor units.` : "Hi {{name}}, we refunded {{amount}} minor units.",
      variables: literalReply ? {} : { name: customer.name, amount: 14000 },
    }, context);
    await tag.run({ requestId: request.id, tag: "damaged" }, context);
    const saved = await stop.run({ demonstrationId: demonstration.id }, context);
    expect(saved.status).toBe("completed");
    expect(saved.steps.map(step => step.action)).toEqual(["get-request", "get-order", "get-shipment-status", "get-customer", "get-request-activity", "issue-refund", "send-reply", "tag-request"]);
    return saved;
  }
  const shopEffects = async () => ({
    refunds: await db.select().from(tables.refunds), replies: await db.select().from(tables.replies), requests: await db.select().from(tables.requests),
  });

  it.each([false, true])("drafts the real broken platter and rebinds every planned action on a different request (literal reply: %s)", async literal => session(async () => {
    expect(order.items[0]).toMatchObject({ name: "Ember Large Serving Platter", unitPrice: { amountMinor: 28000 } });
    expect(targetOrder.items[0]!.unitPrice.amountMinor).not.toBe(28000);
    const demo = await record(literal);
    const before = await shopEffects();
    const result = await draftAction.run({ demonstrationId: demo.id }, context);
    expect(recipeDraftSchema.parse(result)).toEqual(result);
    expect(result.recipe).toMatchObject({ status: "draft", activeVersionId: null });
    expect(result.draft.trigger).toEqual({ event: "request.created", match: { "===": [{ var: "trigger.type" }, "damaged_item"] } });
    expect(result.draft.steps.map(step => step.id)).toEqual(["step_2", "step_6", "step_7", "step_8"]);
    expect(actionStep(result, "issue-refund").args.orderId).toEqual({ mode: "path", path: "trigger.orderId" });
    expect(actionStep(result, "issue-refund").args.amount).toMatchObject({ amountMinor: { mode: "expr", expr: { "*": [{ find: [{ var: "steps.step_2.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor"] }, 0.5] } } });
    expect(actionStep(result, "tag-request").args.tag).toEqual({ mode: "fixed", value: "damaged" });
    expect(result.ambiguities.length).toBeGreaterThan(0);
    const retrieved = await getDraft.run({ versionId: result.draft.id }, { ...context, caller: "mcp" });
    expect(retrieved).toEqual(result);
    expect(await new DrizzleRecipeCatalog(db).getDraft({ userId: context.userEmail, workspaceId: "shop" }, result.draft.id)).toEqual(result);
    expect(await getDraft.run({ versionId: result.draft.id }, { ...context, userEmail: "other@example.test" })).toBeNull();
    expect(await getDraft.run({ versionId: result.draft.id }, { ...context, orgId: "other_shop" })).toBeNull();
    expect(await new DrizzleRecipeCatalog(db).listActive()).toEqual([]);
    const matched = await new MatchRequest({ recipes: new DrizzleRecipeCatalog(db), extractor: { extract } }).execute({
      event: "request.created", content: { source: "structured", fields: target.content.source === "structured" ? target.content.fields as unknown as JsonObject : {} },
      context: { requestId: target.id, customerId: target.customerId, subject: target.subject },
    });
    expect(matched.reason).toBe("no_match");
    const run = await runRecipe.run({ recipe: recipeDraftSchema.parse(retrieved).draft, trigger: matched.trigger, dryRun: true }, context);
    const amount = targetOrder.items[0]!.unitPrice.amountMinor * 0.5;
    expect(run.status).toBe("completed");
    expect(run.steps.map(step => step.status)).toEqual(["completed", "planned", "planned", "planned"]);
    expect(run.steps[0]!.input).toEqual({ orderId: target.orderId });
    expect(run.steps[1]!.input).toEqual({ orderId: target.orderId, amount: { amountMinor: amount, currency: "USD" }, reason: "Damaged item" });
    expect(run.steps[2]!.input).toEqual({ requestId: target.id,
      template: literal ? `Hi ${targetCustomer.name}, we refunded ${amount} minor units.` : "Hi {{name}}, we refunded {{amount}} minor units.",
      variables: literal ? {} : { name: targetCustomer.name, amount },
    });
    expect(run.steps[3]!.input).toEqual({ requestId: target.id, tag: "damaged" });
    expect(run.tokens).toEqual({ input: 0, output: 0 });
    expect(extract).not.toHaveBeenCalled();
    expect(await shopEffects()).toEqual(before);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
    await seedShop(db); // Draft, immutable version and review evidence survive rehearsal reset.
    expect(await getDraft.run({ versionId: result.draft.id }, context)).toEqual(result);
    await seedShop(db, { all: true });
    expect(await getDraft.run({ versionId: result.draft.id }, context)).toBeNull();
  }));

  it("drafts the EXACT UI-recorded plain-text reply and dry-runs a different damaged product on a later line", async () => {
    const demo = JSON.parse(await readFile(new URL("./fixtures/broken-platter-demonstration.json", import.meta.url), "utf8")) as Demonstration;
    const actor = { caller: "frontend" as const, userEmail: demo.scope.userId, orgId: demo.scope.workspaceId };
    await runWithRequestContext({ userEmail: actor.userEmail, orgId: actor.orgId }, async () => {
      expect(demo.id).toBe("demo_de81093c7e515f12");
      expect(demo.steps[6]!.input.template).toBe("Hi Maya, I am so sorry your Ember serving platter arrived chipped. We have refunded $140.00, half of its price. Warmly, Kiln & Co.");
      await new DrizzleTraceStore(db).transaction(records => records.save(demo));
      const inference = inferBindings(demo, demo.trigger);
      const reply = inference.steps.find(step => step.action === "send-reply")!.args.template;
      expect(reply).toMatchObject({ mode: "expr" });
      if (!reply || !("mode" in reply) || reply.mode !== "expr") throw new Error("Expected inferred reply expression");
      expect(expressionPaths(reply.expr)).toContain("steps.step_6.output.amount.amountMinor");
      const result = await draftAction.run({ demonstrationId: demo.id }, actor);
      expect(recipeDraftSchema.parse(result)).toEqual(result);
      expect(result.recipe).toMatchObject({ status: "draft", activeVersionId: null });
      expect(result.draft.steps.map(step => step.id)).toEqual(["step_2", "step_6", "step_7", "step_8"]);
      const selected = { find: [{ var: "steps.step_2.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor"] };
      const currency = { find: [{ var: "steps.step_2.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.currency"] };
      expect(actionStep(result, "issue-refund").args.amount).toEqual({ amountMinor: { mode: "expr", expr: { "*": [selected, 0.5] } }, currency: { mode: "expr", expr: currency } });
      expect(result.ambiguities).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "step_7", argumentPath: "template", kind: "request-specific-text", fragments: expect.arrayContaining(["Ember serving platter"]) })]));
      expect(result.ambiguities.some(item => item.argumentPath === "amount.currency" && item.kind === "multiple-candidates")).toBe(false);
      expect(result.ambiguities.some(item => item.kind === "positional-array")).toBe(false);
      await expect(JSON.stringify({ ...result.draft, id: "ver_reference", recipeId: "recipe_reference" }, null, 2) + "\n").toMatchFileSnapshot("./fixtures/broken-platter-draft.json");
      expect(await getDraft.run({ versionId: result.draft.id }, { ...actor, caller: "mcp" })).toEqual(result);
      // The seeded request still selects the same real product, while reordering
      // its persisted order makes positional selection observably incorrect.
      const chosen = targetOrder.items[0]!;
      await db.update(tables.orders).set({ items: [...targetOrder.items.slice(1), chosen] }).where(eq(tables.orders.id, targetOrder.id));
      expect(target.content.source).toBe("structured");
      if (target.content.source !== "structured") throw new Error("Expected structured seed");
      expect(target.content.fields).toMatchObject({ type: "damaged_item", productId: chosen.productId });
      const before = await shopEffects();
      const payload = buildRequestTrigger(target.content.fields as unknown as JsonObject, { requestId: target.id, customerId: target.customerId, subject: target.subject });
      const run = await runRecipe.run({ recipe: result.draft, trigger: payload, dryRun: true }, actor);
      expect(run.status).toBe("completed");
      expect(run.steps.map(step => step.status)).toEqual(["completed", "planned", "planned", "planned"]);
      const amount = chosen.unitPrice.amountMinor * 0.5;
      expect(amount).not.toBe(14000);
      expect(amount).not.toBe(targetOrder.items[1]!.unitPrice.amountMinor * 0.5);
      expect(run.steps[1]!.input).toEqual({ orderId: targetOrder.id, amount: { amountMinor: amount, currency: chosen.unitPrice.currency }, reason: demo.steps[5]!.input.reason });
      const firstName = targetCustomer.name.split(" ")[0]!;
      expect(firstName).not.toBe("Maya");
      expect(run.steps[2]!.input).toEqual({ requestId: target.id, variables: {}, template: (demo.steps[6]!.input.template as string).replace("Hi Maya,", `Hi ${firstName},`).replace("$140.00", `$${(amount / 100).toFixed(2)}`) });
      expect(run.steps[3]!.input).toEqual({ requestId: target.id, tag: "damaged" });
      expect(run.tokens).toEqual({ input: 0, output: 0 });
      expect(extract).not.toHaveBeenCalled();
      expect(await shopEffects()).toEqual(before);
    });
  });

  it("rejects recording/cancelled/foreign traces and unauthenticated reads with safe action errors", async () => session(async () => {
    const demo = await start.run({ requestId: request.id }, context);
    await expect(draftAction.run({ demonstrationId: demo.id }, context)).rejects.toMatchObject({ errorCode: "DRAFT_INPUT" });
    await expect(draftAction.run({ demonstrationId: demo.id }, { ...context, userEmail: "other@example.test" })).rejects.toMatchObject({ errorCode: "DRAFT_NOT_FOUND" });
    await cancel.run({ demonstrationId: demo.id }, context);
    await expect(draftAction.run({ demonstrationId: demo.id }, context)).rejects.toMatchObject({ errorCode: "DRAFT_INPUT" });
    expect(await db.select().from(tables.recipeDrafts)).toEqual([]);
    await runWithRequestContext({}, async () => {
      await expect(getDraft.run({ versionId: "ver_missing" }, { caller: "cli" })).rejects.toMatchObject({ errorCode: "DRAFT_INPUT" });
    });
  }));

  it("uses confirmed extraction-shaped fields for free text and never infers from its raw message", async () => session(async () => {
    const free = data.requests.find(item => item.content.source === "free_text" && item.orderId)!;
    await writeAppStateForCurrentTab("navigation", { view: "request", requestId: free.id, path: `/requests/${free.id}` });
    const fields = { type: "where_is_my_order" as const, orderId: free.orderId! };
    const demo = await start.run({ requestId: free.id, fields }, context);
    await tag.run({ requestId: free.id, tag: "shipment" }, context);
    await stop.run({ demonstrationId: demo.id }, context);
    const result = await draftAction.run({ demonstrationId: demo.id }, context);
    expect(demo.trigger).toEqual(buildRequestTrigger(fields, { requestId: free.id, customerId: free.customerId, subject: free.subject }));
    expect(result.draft.trigger.match).toEqual({ "===": [{ var: "trigger.type" }, "where_is_my_order"] });
    expect(JSON.stringify(result.draft)).not.toContain("free_text");
    expect(extract).not.toHaveBeenCalled();
  }));

  it("rolls back the immutable version and catalog together if review-evidence storage fails", async () => session(async () => {
    const demo = await record();
    const catalog = new DrizzleRecipeCatalog(db);
    const real = catalog.createDraft.bind(catalog);
    const cases = composition.createDraftRecipeUseCases(db, registry);
    const result = await cases.execute({ demonstrationId: demo.id, owner: { userId: context.userEmail, workspaceId: "shop" } });
    const changed = { ...result, draft: { ...result.draft, id: "ver_rollback", recipeId: "recipe_rollback" }, recipe: { ...result.recipe, id: "recipe_rollback" } };
    await expect(real({ userId: null as unknown as string, workspaceId: "shop" }, changed)).rejects.toThrow();
    expect(await catalog.get("recipe_rollback")).toBeNull();
    expect((await db.select().from(tables.recipeVersions)).map(row => row.id)).not.toContain("ver_rollback");
  }));
});
