import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { listSubscriptions, subscribe, unsubscribe } from "@agent-native/core/event-bus";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { parseRecipeVersion, type JsonObject } from "@muscle-memory/recipe-engine";
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
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import migrateApp from "./plugins/db.js";
import { seedShop } from "./infra/shop-demo-store.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
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
    await db.delete(tables.requestProcessing);
    await db.delete(tables.recipes);
    await db.delete(tables.recipeHandoffs);
    await db.delete(tables.recipeRuns);
    await db.delete(tables.recipeVersions);
    await seedShop(db);
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
    await Promise.all([cases.intake.events.emit(created.id), create().intake.events.emit(created.id)]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(1);
    expect(await db.select().from(tables.replies).where(eq(tables.replies.requestId, created.id))).toHaveLength(1);
    expect(listSubscriptions("request.created")).toHaveLength(1);
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
    expect((await cases.processing.list([request.value.id]))[0]?.state).toBe("with_agent");
    await expect(cases.intake.events.emit("req_missing")).rejects.toThrow("failed to accept");
  });
});
