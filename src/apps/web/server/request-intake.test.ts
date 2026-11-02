import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { closeDbExec, getDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { listSubscriptions, subscribe, unsubscribe } from "@agent-native/core/event-bus";
import { loadActionsFromStaticRegistry, runWithRequestContext } from "@agent-native/core/server";
import { parseRecipeVersion, type JsonObject } from "@muscle-memory/recipe-engine";
import { ClassifyRequest } from "@muscle-memory/shop-domain";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import createRequest from "../actions/create-request.js";
import demoIntake from "../actions/demo-intake.js";
import listRequestProcessing from "../actions/list-request-processing.js";
import getOrder from "../actions/get-order.js";
import getShipmentStatus from "../actions/get-shipment-status.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import tagRequest from "../actions/tag-request.js";
import resumeRecipeRun from "../actions/resume-recipe-run.js";
import setRequestStatus from "../actions/set-request-status.js";
import startDemonstration from "../actions/start-demonstration.js";
import stopDemonstration from "../actions/stop-demonstration.js";
import getRequest from "../actions/get-request.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import migrateApp from "./plugins/db.js";
import { resetShop, seedShop } from "./infra/shop-demo-store.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import { demoIntakeScript } from "./infra/demo-intake.js";
import { damagedItemFixture, whereIsMyOrderFixture } from "./fixtures/intake-recipes.js";

const context = { caller: "frontend" as const, userEmail: "operator@example.test" };

describe("request.created intake: real actions/event bus/executor on PGlite, offline extractor", () => {
  let directory: string;
  let db: ShopDb;
  let sequence = 0;
  const extract = vi.fn(async (): Promise<{ output: JsonObject; tokens: { input: number; output: number } }> => ({
    output: { type: "where_is_my_order", orderId: "ord_1042" }, tokens: { input: 12, output: 8 },
  }));
  const registry = new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({
    "get-order": { default: getOrder }, "get-shipment-status": { default: getShipmentStatus },
    "issue-refund": { default: issueRefund }, "send-reply": { default: sendReply }, "tag-request": { default: tagRequest },
  }));
  const options = () => ({ context, registry, extractor: { extract }, ids: { next: () => `run_intaketest${++sequence}` } });
  const create = () => composition.createRequestIntake(db, options());

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-intake-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => { await migrateApp(undefined); });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await seedShop(db, { all: true });
    extract.mockReset();
    extract.mockResolvedValue({ output: { type: "where_is_my_order", orderId: "ord_1042" }, tokens: { input: 12, output: 8 } });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await closeDbExec(); vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function activateFixtures() {
    const cases = create();
    for (const recipe of [damagedItemFixture, whereIsMyOrderFixture]) {
      await cases.catalog.saveVersion(recipe);
      await cases.catalog.save({ id: recipe.recipeId, name: recipe.name, status: "active", activeVersionId: recipe.id });
    }
    return cases;
  }

  async function resetSnapshot() {
    // Compare every affected table, including recipe metadata, after rollback.
    const entries = await Promise.all(Object.entries(tables).map(async ([name, table]) => {
      const rows = await db.select().from(table);
      return [name, rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
    }));
    return Object.fromEntries(entries);
  }

  it.each(["seed", "reset"] as const)("%s after demo-intake removes shop operations and retains reusable recipes", async command => {
    const cases = await activateFixtures();
    vi.spyOn(composition, "getRequestIntake").mockReturnValue(cases);
    const first = await demoIntake.run({}, context);
    expect(await db.select().from(tables.requestProcessing)).toHaveLength(5);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(5);
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(1);
    const catalog = await db.select().from(tables.recipes).orderBy(tables.recipes.id);
    const versions = await db.select().from(tables.recipeVersions).orderBy(tables.recipeVersions.id);
    if (command === "seed") await seedShop(db);
    else await resetShop(db);
    expect(await db.select().from(tables.requestProcessing)).toEqual([]);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
    expect(await db.select().from(tables.recipeRuns)).toEqual([]);
    expect(await db.select().from(tables.requests)).toHaveLength(command === "seed" ? 60 : 0);
    expect(await db.select().from(tables.recipes).orderBy(tables.recipes.id)).toEqual(catalog);
    expect(await db.select().from(tables.recipeVersions).orderBy(tables.recipeVersions.id)).toEqual(versions);
    if (command === "reset") {
      await resetShop(db); // Empty repeat reset is safe too.
      await seedShop(db);
    }
    const fresh = create();
    expect(await fresh.catalog.listActive()).toHaveLength(2);
    vi.mocked(composition.getRequestIntake).mockReturnValue(fresh);
    const second = await demoIntake.run({}, context);
    expect(second.map(request => request.id)).toEqual(first.map(request => request.id));
    expect((await fresh.processing.list()).map(row => row.state).sort()).toEqual([
      "auto_handled", "auto_handled", "auto_handled", "awaiting_approval", "with_agent",
    ]);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(5);
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(1);
  });

  it("removes ad hoc request runs and associations, keeps generic runs by default, and clears everything with all", async () => {
    const recipe = parseRecipeVersion({
      id: "ver_reset_scope", recipeId: "recipe_reset_scope", version: 1, name: "Scope check",
      trigger: { event: "request.created", match: true },
      // oxlint-disable-next-line unicorn/no-thenable -- Recipe DSL branches use a non-callable then array.
      steps: [{ id: "branch", kind: "branch", condition: true, then: [], else: [] }],
    });
    const triggers: JsonObject[] = [{ requestId: "req_0001" }, { id: "req_0002" }, { requestId: "req_deleted" }, { topic: "intake checkpoint" }];
    const shopRunIds: string[] = [];
    for (const trigger of triggers) {
      const run = await composition.createRecipeUseCases(db, options()).runRecipe.execute({ recipe, trigger });
      shopRunIds.push(run.id);
    }
    // This association must be honored even when the run has a generic trigger.
    await db.insert(tables.requestProcessing).values({ requestId: "req_0003", runId: shopRunIds[3]! });
    const genericRecipe = parseRecipeVersion({
      ...recipe, id: "ver_generic_queue", recipeId: "recipe_generic_queue", name: "Generic queue",
      steps: [{ id: "queue", kind: "handoff", to: "human", note: { mode: "fixed", value: "Review this generic job" } }],
    });
    const generic = await composition.createRecipeUseCases(db, options()).runRecipe.execute({ recipe: genericRecipe, trigger: { id: "job_001" } });
    expect(generic.status).toBe("handed_off");
    await seedShop(db);
    expect((await db.select().from(tables.recipeRuns)).map(row => row.id)).toEqual([generic.id]);
    expect(await db.select().from(tables.recipeHandoffs)).toMatchObject([{ runId: generic.id, requestId: null }]);
    expect(await db.select().from(tables.requestProcessing)).toEqual([]);
    expect(await db.select().from(tables.recipeVersions)).toHaveLength(2);
    await resetShop(db, { all: true });
    for (const table of [tables.recipes, tables.recipeVersions, tables.recipeRuns, tables.recipeHandoffs, tables.requestProcessing, tables.requests]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  });

  it.each([false, true])("rolls back operational, shop and catalog cleanup on a late seed failure (all=%s)", async all => {
    const cases = await activateFixtures();
    await cases.demo.execute();
    const before = await resetSnapshot();
    await getDbExec().execute("CREATE FUNCTION task15_reject_seed_reply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test seed failure'; END; $$");
    await getDbExec().execute("CREATE TRIGGER task15_reject_seed_reply BEFORE INSERT ON replies FOR EACH ROW EXECUTE FUNCTION task15_reject_seed_reply()");
    try {
      await expect(seedShop(db, { all })).rejects.toThrow();
      expect(await resetSnapshot()).toEqual(before);
    } finally {
      await getDbExec().execute("DROP TRIGGER task15_reject_seed_reply ON replies");
      await getDbExec().execute("DROP FUNCTION task15_reject_seed_reply()");
    }
  });

  it("injects 5 real requests -> 3 auto_handled, 1 awaiting_approval, 1 with_agent; state follows resume and resolution", async () => {
    const cases = await activateFixtures();
    vi.spyOn(composition, "getRequestIntake").mockReturnValue(cases);
    vi.spyOn(composition, "getRecipeUseCases").mockImplementation(() => composition.createRecipeUseCases(db, options()));
    const originalRefunds = await db.select().from(tables.refunds);
    const originalReplies = await db.select().from(tables.replies);
    const seen: string[] = [];
    const observer = subscribe("request.created", async (payload) => { seen.push((payload as { requestId: string }).requestId); });
    let created;
    try { created = await demoIntake.run({}, context); }
    finally { unsubscribe(observer); }
    expect((await demoIntake.outputSchema!["~standard"].validate(created)).issues).toBeUndefined();
    expect(created).toHaveLength(5);
    expect(created.map(request => request.id)).toEqual(["req_0061", "req_0062", "req_0063", "req_0064", "req_0065"]);
    expect(created[2]?.content).toEqual({ ...demoIntakeScript[2]!.content, type: "where_is_my_order" });
    expect(seen).toEqual(created.map((request) => request.id));
    const states = await listRequestProcessing.run({ requestIds: created.map((request) => request.id) }, context);
    expect((await listRequestProcessing.outputSchema!["~standard"].validate(states)).issues).toBeUndefined();
    const inOrder = created.map((request) => states.find((row) => row.requestId === request.id)!);
    expect(inOrder.map((row) => row.state)).toEqual(["auto_handled", "auto_handled", "auto_handled", "awaiting_approval", "with_agent"]);
    expect(inOrder.map((row) => row.tokens)).toEqual([
      { input: 0, output: 0 }, { input: 0, output: 0 }, { input: 12, output: 8 }, { input: 0, output: 0 }, { input: 0, output: 0 },
    ]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tables.refunds)).toHaveLength(originalRefunds.length + 2);
    expect(await db.select().from(tables.replies)).toHaveLength(originalReplies.length + 3);
    const recentRefunds = (await db.select().from(tables.refunds)).filter((refund) => !originalRefunds.some((original) => original.id === refund.id));
    expect(recentRefunds.map((refund) => refund.amount.amountMinor).sort()).toEqual([1300, 2200]);
    expect(created.slice(0, 3).every((request) => request.tags.includes("recipe-handled"))).toBe(true);
    expect(created[4]).toMatchObject({ status: "escalated", escalation: { reason: expect.stringContaining("No active recipe") } });
    const [handoff] = await db.select().from(tables.recipeHandoffs);
    expect(handoff).toMatchObject({ requestId: created[4]!.id, disposition: "with_agent", context: { trigger: { requestId: created[4]!.id } } });
    // No refund occurs before the > USD 100 gate; later approval uses the real action.
    const paused = await composition.createRecipeUseCases(db).runs.get(inOrder[3]!.runId);
    expect(paused).toMatchObject({ status: "awaiting_approval", awaitingApprovalStepId: "refund" });
    await resumeRecipeRun.run({ runId: paused!.id, approval: { stepId: "refund", decision: "approve" }, retry: false }, context);
    expect((await cases.processing.list([created[3]!.id]))[0]?.state).toBe("done");
    expect(await db.select().from(tables.refunds)).toHaveLength(originalRefunds.length + 3);
    await setRequestStatus.run({ requestId: created[0]!.id, status: "resolved" }, context);
    expect((await cases.processing.list([created[0]!.id]))[0]?.state).toBe("done");
    // Saved association/query works in a fresh factory, without re-extracting.
    expect(await create().processing.list([created[4]!.id])).toEqual([inOrder[4]]);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("create-request awaits processing and concurrent duplicate emissions reuse one extraction/run/reply", async () => {
    const cases = await activateFixtures();
    vi.spyOn(composition, "getRequestIntake").mockReturnValue(cases);
    const created = await createRequest.run(demoIntakeScript[2]!, context);
    expect((await createRequest.outputSchema!["~standard"].validate(created)).issues).toBeUndefined();
    expect((await cases.processing.list([created.id]))[0]?.state).toBe("auto_handled");
    const freshShop = new DrizzleShopRepository(db);
    expect((await freshShop.getRequest(created.id))?.content).toEqual({ ...demoIntakeScript[2]!.content, type: "where_is_my_order" });
    expect((await freshShop.listRequests({ type: "where_is_my_order" })).some(request => request.id === created.id)).toBe(true);
    expect((await freshShop.listRequests({ type: "damaged_item" })).some(request => request.id === created.id)).toBe(false);
    await Promise.all([cases.intake.events.emit(created.id), create().intake.events.emit(created.id)]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(1);
    expect(await db.select().from(tables.replies).where(eq(tables.replies.requestId, created.id))).toHaveLength(1);
    expect(listSubscriptions("request.created")).toHaveLength(1);
  });

  it("recovers a failed classification write from the saved match without another extraction", async () => {
    const cases = await activateFixtures();
    vi.spyOn(ClassifyRequest.prototype, "execute").mockRejectedValueOnce(new Error("Storage interrupted"));
    await expect(cases.intake.create(demoIntakeScript[2]!)).rejects.toThrow();
    const [checkpoint] = await db.select().from(tables.requestProcessing);
    expect(checkpoint?.match).toMatchObject({ reason: "matched", trigger: { type: "where_is_my_order" } });
    const shop = new DrizzleShopRepository(db);
    expect((await shop.getRequest(checkpoint!.requestId))?.content).toMatchObject({ type: null });
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(0);
    await create().intake.events.emit(checkpoint!.requestId);
    const classified = await shop.getRequest(checkpoint!.requestId);
    expect(classified?.content).toEqual({ ...demoIntakeScript[2]!.content, type: "where_is_my_order" });
    expect(extract).toHaveBeenCalledTimes(1);
    expect((await cases.processing.list([checkpoint!.requestId]))[0]?.state).toBe("auto_handled");
    expect(await db.select().from(tables.replies).where(eq(tables.replies.requestId, checkpoint!.requestId))).toHaveLength(1);
  });

  it("matches a naturally named damaged product with only its order context and reuses the saved match", async () => {
    const cases = await activateFixtures();
    const shop = new DrizzleShopRepository(db);
    const order = (await shop.getOrder("ord_1006"))!;
    const line = order.items[0]!;
    const text = `Hi, one ${line.name} from ${order.id} arrived chipped. Could you arrange a partial refund?`;
    extract.mockResolvedValue({ output: { type: "damaged_item", orderId: order.id, productId: line.productId,
      productMention: line.name, quantity: 1, description: "Chipped rim" }, tokens: { input: 30, output: 15 } });
    const request = await cases.intake.create({ customerId: order.customerId, subject: "Chipped bowl", content: { source: "free_text", text } });
    expect(request.content).toEqual({ source: "free_text", text, type: "damaged_item" });
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ text, context: {
      orderId: order.id, lines: await Promise.all(order.items.map(async ({ name, productId, quantity }) => ({
        name, sku: (await shop.getProduct(productId))!.sku, productId, quantity,
      }))),
    } }));
    expect((await cases.processing.list([request.id]))[0]).toMatchObject({ state: "auto_handled", tokens: { input: 30, output: 15 } });
    await create().intake.events.emit(request.id);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tables.replies).where(eq(tables.replies.requestId, request.id))).toHaveLength(1);
  });

  it.each(["provider", "incomplete", "wrong_customer"])("hands extraction %s failure to existing AgentHandoff, preserving known usage", async (failure) => {
    const cases = await activateFixtures();
    if (failure === "provider") extract.mockRejectedValue(new Error("Private details"));
    if (failure === "incomplete") extract.mockResolvedValue({ output: { type: "damaged_item", orderId: "ord_1042" }, tokens: { input: 9, output: 3 } });
    if (failure === "wrong_customer") extract.mockResolvedValue({ output: { type: "where_is_my_order", orderId: "ord_1001" }, tokens: { input: 9, output: 3 } });
    const request = await cases.intake.create(demoIntakeScript[2]!);
    const [processing] = await cases.processing.list([request.id]);
    expect(processing).toMatchObject({ state: "with_agent", matchReason: "extraction_failed", tokens: failure === "provider" ? { input: 0, output: 0 } : { input: 9, output: 3 } });
    expect(request.status).toBe("escalated");
    expect(request.content).toMatchObject({ source: "free_text", type: null });
    await cases.intake.events.emit(request.id);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(1);
  });

  it("matches only active catalog pointers; catalog writes enforce ownership and immutable versions", async () => {
    const cases = create();
    await cases.catalog.saveVersion(whereIsMyOrderFixture);
    await cases.catalog.save({ id: whereIsMyOrderFixture.recipeId, name: "Shipment draft", status: "draft", activeVersionId: null });
    expect(await cases.catalog.listActive()).toEqual([]);
    const request = await cases.intake.create(demoIntakeScript[2]!);
    expect((await cases.processing.list([request.id]))[0]).toMatchObject({ state: "with_agent", matchReason: "no_match" });
    expect(request.content).toEqual({ ...demoIntakeScript[2]!.content, type: "where_is_my_order" });
    await expect(cases.catalog.save({ id: "recipe_other", name: "Wrong owner", status: "active", activeVersionId: whereIsMyOrderFixture.id })).rejects.toThrow();
    await expect(cases.catalog.save({ id: "recipe_missing", name: "Missing version", status: "active", activeVersionId: "ver_missing" })).rejects.toThrow();
    await expect(cases.catalog.save({ id: "recipe_invalid", name: "Invalid active", status: "active", activeVersionId: null })).rejects.toThrow();
    await expect(cases.catalog.saveVersion(parseRecipeVersion({ ...whereIsMyOrderFixture, name: "Changed" }))).rejects.toThrow("different snapshot");
    await expect(db.update(tables.recipeVersions).set({ snapshot: whereIsMyOrderFixture }).where(eq(tables.recipeVersions.id, whereIsMyOrderFixture.id))).rejects.toThrow();
    const v2 = parseRecipeVersion({ ...whereIsMyOrderFixture, id: "ver_shipment_two", version: 2, name: "Shipment v2" });
    await cases.catalog.saveVersion(v2);
    await cases.catalog.save({ id: v2.recipeId, name: v2.name, status: "active", activeVersionId: v2.id });
    expect(await create().catalog.listActive()).toEqual([v2]);
    expect(await create().catalog.get(v2.recipeId)).toMatchObject({ activeVersionId: v2.id, status: "active" });
  });

  it("an interrupted matching checkpoint hands off without another extraction, and handler errors propagate", async () => {
    const cases = await activateFixtures();
    const request = await composition.createShopUseCases({
      shop: new (await import("./infra/shop-repository.js")).DrizzleShopRepository(db),
      clock: { now: () => "2026-11-02T12:00:00.000Z" }, ids: { next: () => "req_interrupted" },
    }).createRequest.execute(demoIntakeScript[2]!);
    if (!request.ok) throw new Error("Fixture request failed");
    await db.insert(tables.requestProcessing).values({ requestId: request.value.id, runId: "run_interrupted" });
    await cases.intake.events.emit(request.value.id);
    expect(extract).not.toHaveBeenCalled();
    expect((await new DrizzleShopRepository(db).getRequest(request.value.id))?.content).toMatchObject({ type: null });
    expect((await cases.processing.list([request.value.id]))[0]?.state).toBe("with_agent");
    await expect(cases.intake.events.emit("req_missing")).rejects.toThrow("failed to accept");
  });

  it("supports the root seed/reset CLI after intake and forwards the explicit pristine flag", async () => {
    const cases = await activateFixtures();
    await cases.demo.execute();
    await runWithRequestContext({ userEmail: context.userEmail, orgId: "shop", run: { browserTabId: "reseed_teach" } }, async () => {
      await writeAppStateForCurrentTab("navigation", { view: "request", requestId: "req_0001", path: "/requests/req_0001" });
      const demo = await startDemonstration.run({ requestId: "req_0001" }, context);
      await getRequest.run({ requestId: "req_0001" }, context);
      await tagRequest.run({ requestId: "req_0001", tag: "rehearsal" }, context);
      const saved = await stopDemonstration.run({ demonstrationId: demo.id }, context);
      expect(saved.status).toBe("completed");
      expect(saved.steps.map(step => step.action)).toEqual(["get-request", "tag-request"]);
    });
    expect(await db.select().from(tables.demonstrations)).toHaveLength(1);
    expect(await db.select().from(tables.demoSteps)).toHaveLength(2);
    const catalog = await db.select().from(tables.recipes).orderBy(tables.recipes.id);
    const exec = promisify(execFile);
    const cli = async (command: string, flags: string[] = []) => {
      // PGlite has a single process owner. Close before a real CLI process,
      // then obtain a fresh framework DB handle to verify persisted results.
      await closeDbExec();
      try {
        return await exec("pnpm", ["-C", path.resolve(import.meta.dirname, "../../.."), command, ...flags], {
          env: { ...process.env, DATABASE_URL: `pglite:${directory}` }, timeout: 30_000, maxBuffer: 1_000_000,
        });
      } finally { db = getDb(); }
    };
    expect((await cli("seed:shop")).stdout).toContain("Recipe catalog, versions and unrelated recipe runs retained");
    expect(await db.select().from(tables.requests)).toHaveLength(60);
    expect(await db.select().from(tables.requestProcessing)).toEqual([]);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
    expect(await db.select().from(tables.recipeRuns)).toEqual([]);
    expect(await db.select().from(tables.demonstrations)).toEqual([]);
    expect(await db.select().from(tables.demoSteps)).toEqual([]);
    expect(await db.select().from(tables.recipes).orderBy(tables.recipes.id)).toEqual(catalog);
    await expect(cli("seed:shop", ["--al"])).rejects.toThrow("Usage:");
    expect(await db.select().from(tables.requests)).toHaveLength(60);
    expect(await db.select().from(tables.recipes).orderBy(tables.recipes.id)).toEqual(catalog);
    await create().intake.create(demoIntakeScript[0]!);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(1);
    await cli("reset:shop");
    expect(await db.select().from(tables.requests)).toEqual([]);
    expect(await db.select().from(tables.recipeRuns)).toEqual([]);
    expect(await db.select().from(tables.requestProcessing)).toEqual([]);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
    expect(await db.select().from(tables.recipes).orderBy(tables.recipes.id)).toEqual(catalog);
    await cli("seed:shop", ["--all"]);
    expect(await db.select().from(tables.requests)).toHaveLength(60);
    expect(await db.select().from(tables.recipes)).toEqual([]);
    expect(await db.select().from(tables.recipeVersions)).toEqual([]);
    // A normal action can create real operations again, even with an empty catalog.
    await create().intake.create(demoIntakeScript[0]!);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(1);
    await cli("reset:shop", ["--all"]);
    for (const table of [tables.requests, tables.recipes, tables.recipeVersions, tables.recipeRuns, tables.recipeHandoffs, tables.requestProcessing]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  }, 30_000);
});
