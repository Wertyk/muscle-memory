import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { parseRecipeVersion, type Step } from "@muscle-memory/recipe-engine";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { recipeVersionInputSchema, recipeJsonInputSchema, booleanFlagSchema } from "./recipe-action-contracts.js";
import getOrder from "../actions/get-order.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import tagRequest from "../actions/tag-request.js";
import runRecipe from "../actions/run-recipe.js";
import resumeRecipeRun from "../actions/resume-recipe-run.js";
import getRecipeRun from "../actions/get-recipe-run.js";
import listRecipeRuns from "../actions/list-recipe-runs.js";
import { APPROVAL_CARD_RENDERER, RUN_CARD_RENDERER } from "../shared/recipe-runs.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import { createShopDemoData, DEMO_NOW } from "./db/shop-demo-data.js";
import migrateApp from "./plugins/db.js";
import { seedShop } from "./infra/shop-demo-store.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { DrizzleRunRepository } from "./infra/run-repository.js";
import { CompleteTextExtractor } from "./infra/complete-text-extraction.js";

const data = createShopDemoData(DEMO_NOW);
const request = data.requests.find((r) => r.status === "open" && r.content.source === "structured" && r.content.fields.type === "damaged_item")!;
const order = data.orders.find((o) => o.id === request.orderId)!;
const trigger = { requestId: request.id, orderId: order.id, reason: "damaged_item" };
const context = { caller: "frontend" as const, userEmail: "operator@example.test" };
const fixed = (value: string | number | boolean) => ({ mode: "fixed" as const, value });
const steps: Step[] = [
  { id: "order", kind: "action", action: "get-order", args: { orderId: { mode: "path", path: "trigger.orderId" } } },
  { id: "refund", kind: "action", action: "issue-refund", args: {
    orderId: { mode: "path", path: "steps.order.output.id" },
    amount: { amountMinor: { mode: "expr", expr: { round: [{ "*": [{ var: "steps.order.output.items[0].unitPrice.amountMinor" }, 0.5] }] } }, currency: fixed("USD") },
    reason: { mode: "template", template: "Damaged item for {{trigger.requestId}}" },
  } },
  { id: "reply", kind: "action", action: "send-reply", args: {
    requestId: { mode: "path", path: "trigger.requestId" },
    template: fixed("We refunded {{amount}} minor units for the damaged item."),
    variables: { amount: { mode: "path", path: "steps.refund.output.amount.amountMinor" } },
  } },
  { id: "tag", kind: "action", action: "tag-request", args: { requestId: { mode: "path", path: "trigger.requestId" }, tag: fixed("recipe-handled") } },
];
const recipe = (override: readonly Step[] = steps, id = "ver_damaged") => parseRecipeVersion({
  id, recipeId: id.replace("ver_", "recipe_"), version: 1, name: "Damaged item half refund",
  trigger: { event: "request.created", match: { "===": [{ var: "trigger.reason" }, "damaged_item"] } }, steps: override,
});

describe("recipe execution against REAL seeded shop actions on PGlite", () => {
  let directory: string;
  let db: ShopDb;
  let sequence = 0;
  const extract = vi.fn(async () => ({ output: { fraction: 0.5 }, tokens: { input: 8, output: 4 } }));
  const registry = new RegistryActionInvoker(async () => loadActionsFromStaticRegistry({
    "get-order": { default: getOrder }, "issue-refund": { default: issueRefund },
    "send-reply": { default: sendReply }, "tag-request": { default: tagRequest },
  }));
  const create = () => composition.createRecipeUseCases(db, { context, registry, extractor: { extract }, ids: { next: () => `run_test${++sequence}` } });

  beforeAll(async () => {
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-recipes-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => { await migrateApp(undefined); });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await db.delete(tables.recipeHandoffs);
    await db.delete(tables.recipeRuns);
    await db.delete(tables.recipeVersions);
    await seedShop(db);
    extract.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function shopSnapshot() {
    return {
      customers: await db.select().from(tables.customers).orderBy(asc(tables.customers.id)),
      products: await db.select().from(tables.products).orderBy(asc(tables.products.id)),
      orders: await db.select().from(tables.orders).orderBy(asc(tables.orders.id)),
      shipments: await db.select().from(tables.shipments).orderBy(asc(tables.shipments.id)),
      requests: await db.select().from(tables.requests).orderBy(asc(tables.requests.id)),
      refunds: await db.select().from(tables.refunds).orderBy(asc(tables.refunds.id)),
      replies: await db.select().from(tables.replies).orderBy(asc(tables.replies.id)),
    };
  }
  const refunds = () => db.select().from(tables.refunds).where(eq(tables.refunds.orderId, order.id));
  const replies = () => db.select().from(tables.replies).where(eq(tables.replies.requestId, request.id));

  it("runs half-refund/reply/tag with bindings, durable write-ahead intents and complete metrics (AC #1/#5)", async () => {
    const cases = create();
    const invoke = registry.invoke.bind(registry);
    vi.spyOn(registry, "invoke").mockImplementation(async (name, input, ctx) => {
      const checkpoint = await new DrizzleRunRepository(db).get(ctx.runId!);
      expect(checkpoint?.steps[checkpoint.steps.length - 1]).toMatchObject({ status: "running", action: name, input });
      return invoke(name, input, ctx);
    });
    const run = await cases.runRecipe.execute({ recipe: recipe(), trigger });
    expect(run.status).toBe("completed");
    expect(extract).not.toHaveBeenCalled();
    expect(run.tokens).toEqual({ input: 0, output: 0 });
    const amount = Math.round(order.items[0]!.unitPrice.amountMinor * 0.5);
    expect(await refunds()).toMatchObject([{ orderId: order.id, amount: { amountMinor: amount, currency: "USD" } }]);
    expect(await replies()).toMatchObject([{ body: `We refunded ${amount} minor units for the damaged item.` }]);
    expect((await composition.getShopUseCases().getRequest.execute({ requestId: request.id }))).toMatchObject({ ok: true, value: { tags: expect.arrayContaining(["recipe-handled"]) } });
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "completed", "completed", "completed"]);
    for (const log of run.steps) {
      expect(log).toMatchObject({ attempt: 1, error: null, tokens: { input: 0, output: 0 } });
      expect(log.durationMs).toBeGreaterThanOrEqual(0);
      expect(log.finishedAt).toBeGreaterThanOrEqual(log.startedAt);
      expect(log.input).not.toBeNull();
      expect(log.output).not.toBeNull();
    }
    const fresh = new DrizzleRunRepository(db);
    expect(await fresh.get(run.id)).toEqual(run);
    expect((await db.select().from(tables.recipeVersions))[0]?.snapshot).toEqual(recipe());
    const changedCopy = await fresh.get(run.id);
    (changedCopy!.steps as unknown[]).pop();
    expect(await fresh.get(run.id)).toEqual(run);
    await expect(fresh.save({ ...run, id: "run_missing" })).rejects.toThrow("missing");
    await expect(fresh.save({ ...run, mode: "dry-run" })).rejects.toThrow("incompatible");
  });

  it("persists approval after a refund, resumes across fresh executors and serializes simultaneous approvals", async () => {
    const gated = steps.map((s) => s.id === "reply" ? { ...s, approval: true } : s);
    const paused = await create().runRecipe.execute({ recipe: recipe(gated), trigger });
    expect(paused.status).toBe("awaiting_approval");
    expect(await refunds()).toHaveLength(1);
    expect(await replies()).toHaveLength(0);
    const input = { runId: paused.id, approval: { stepId: "reply", decision: "approve" as const } };
    const [one, two] = await Promise.all([create().runRecipe.resume(input), create().runRecipe.resume(input)]);
    expect(one.status).toBe("completed");
    expect(two).toEqual(one);
    expect(await new DrizzleRunRepository(db).get(paused.id)).toEqual(one);
    expect(await refunds()).toHaveLength(1);
    expect(await replies()).toHaveLength(1);
    expect(one.steps.filter((s) => s.stepId === "refund")).toHaveLength(1);
  });

  it("rejects a recipe gate permanently before issuing any refund", async () => {
    const gated = steps.map((s) => s.id === "refund" ? { ...s, approval: true } : s);
    const paused = await create().runRecipe.execute({ recipe: recipe(gated), trigger });
    const aborted = await create().runRecipe.resume({ runId: paused.id, approval: { stepId: "refund", decision: "reject" } });
    expect(aborted.status).toBe("aborted");
    expect(await refunds()).toHaveLength(0);
    expect(await create().runRecipe.resume({ runId: paused.id, retry: true })).toEqual(aborted);
  });

  it("dry-run leaves EVERY shop table unchanged, logs planned/blocked effects, and persists its own simulation", async () => {
    const before = await shopSnapshot();
    const run = await create().runRecipe.execute({ recipe: recipe(), trigger, mode: "dry-run" });
    expect(run.status).toBe("completed");
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "planned", "blocked", "planned"]);
    expect(run.steps[1]?.input).toMatchObject({ orderId: order.id, amount: { amountMinor: Math.round(order.items[0]!.unitPrice.amountMinor * 0.5) } });
    expect(await shopSnapshot()).toEqual(before);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
    expect(await create().runs.get(run.id)).toEqual(run);
    const handoff = recipe([{ id: "agent", kind: "handoff", to: "agent", note: fixed("Novel inquiry") }], "ver_handoff");
    await create().runRecipe.execute({ recipe: handoff, trigger, mode: "dry-run" });
    expect(await shopSnapshot()).toEqual(before);
    expect(await db.select().from(tables.recipeHandoffs)).toEqual([]);
  });

  it("keeps completed checkpoints on callback failure; interrupted mutation hands off without duplicate refunds", async () => {
    const cases = create();
    const save = cases.runs.save.bind(cases.runs);
    vi.spyOn(cases.runs, "save").mockImplementation(async (run) => {
      if (run.steps.some((s) => s.stepId === "refund" && s.status === "completed")) throw new Error("result checkpoint unavailable");
      await save(run);
    });
    await expect(cases.runRecipe.execute({ recipe: recipe(), trigger })).rejects.toThrow("result checkpoint unavailable");
    const [row] = await db.select().from(tables.recipeRuns);
    expect(row?.checkpoint.steps.map((s) => s.status)).toEqual(["completed", "running"]);
    expect(await refunds()).toHaveLength(1);
    const recovered = await create().runRecipe.resume({ runId: row!.id, retry: true });
    expect(recovered.status).toBe("handed_off");
    expect(recovered.handoff?.context.reason).toBe("interrupted");
    expect(await refunds()).toHaveLength(1);
    expect(await replies()).toHaveLength(0);
    expect((await db.select().from(tables.recipeHandoffs))[0]).toMatchObject({ disposition: "with_agent", requestId: request.id });
    expect(await composition.getShopUseCases().getRequest.execute({ requestId: request.id })).toMatchObject({ ok: true, value: { status: "escalated", escalation: { reason: expect.stringContaining("interrupted") } } });
    await create().runRecipe.resume({ runId: row!.id, retry: true });
    expect(await refunds()).toHaveLength(1);
  });

  it("deduplicates handoff delivery after its result checkpoint is lost, for agent and human targets", async () => {
    for (const to of ["agent", "human"] as const) {
      const cases = create();
      const save = cases.runs.save.bind(cases.runs);
      vi.spyOn(cases.runs, "save").mockImplementation(async (run) => {
        if (run.handoff?.status === "delivered") throw new Error("lost delivery checkpoint");
        await save(run);
      });
      await expect(cases.runRecipe.execute({ recipe: recipe([{ id: "agent", kind: "handoff", to, note: fixed("Needs custom handling") }], `ver_${to}`), trigger })).rejects.toThrow("lost delivery checkpoint");
      const rows = await db.select().from(tables.recipeHandoffs).where(eq(tables.recipeHandoffs.disposition, to === "agent" ? "with_agent" : "with_human"));
      expect(rows).toHaveLength(1);
      const before = await shopSnapshot();
      const recovered = await create().runRecipe.resume({ runId: rows[0]!.runId });
      expect(recovered.handoff?.status).toBe("delivered");
      expect(recovered.status).toBe("handed_off");
      expect(await shopSnapshot()).toEqual(before);
    }
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(2);
  });

  it("rolls back a handoff record if escalation fails and safely retries delivery", async () => {
    const run = await create().runRecipe.execute({ recipe: recipe([{ id: "agent", kind: "handoff", to: "agent", note: fixed("Review") }]), trigger: { requestId: "req_missing" } });
    expect(run.status).toBe("failed");
    expect(run.handoff?.status).toBe("pending");
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(0);
    const saved = { ...request, id: "req_missing" as const };
    await db.insert(tables.requests).values(saved);
    const resumed = await create().runRecipe.resume({ runId: run.id });
    expect(resumed.status).toBe("handed_off");
    expect(await db.select().from(tables.recipeHandoffs)).toHaveLength(1);
  });

  it("normalizes real shop policy failures and safely hands them off", async () => {
    const broken = recipe([{ id: "refund", kind: "action", action: "issue-refund", args: {
      orderId: fixed(order.id), amount: { amountMinor: fixed(order.paid.amountMinor + 1), currency: fixed("USD") }, reason: fixed("Test invalid refund"),
    } }]);
    const run = await create().runRecipe.execute({ recipe: broken, trigger });
    expect(run.status).toBe("handed_off");
    expect(run.steps[0]?.error).toContain("REFUND_EXCEEDS_BALANCE");
    expect(await refunds()).toHaveLength(0);
  });

  it("rejects colliding run IDs and edited/reused version identities without changing existing snapshots", async () => {
    const cases = create();
    const run = await cases.runRecipe.execute({ recipe: recipe(), trigger, mode: "dry-run" });
    await expect(cases.runs.create(run)).rejects.toThrow();
    await expect(cases.runRecipe.execute({ recipe: { ...recipe(), name: "Edited in place" }, trigger })).rejects.toThrow("different snapshot");
    await expect(cases.runRecipe.execute({ recipe: { ...recipe(), id: "ver_same_number" }, trigger })).rejects.toThrow("different snapshot");
    await expect(db.update(tables.recipeVersions).set({ version: 2 })).rejects.toThrow();
    expect(await cases.runs.get(run.id)).toEqual(run);
    expect(await db.select().from(tables.recipeRuns)).toHaveLength(1);
  });

  it("counts extraction tokens in persisted attempts, including invalid declared fields", async () => {
    const extraction: Step[] = [{ id: "fields", kind: "extract", text: fixed("broken mug"), fields: { fraction: { type: "number", required: true } } }];
    const run = await create().runRecipe.execute({ recipe: recipe(extraction), trigger });
    expect(run.tokens).toEqual({ input: 8, output: 4 });
    expect((await create().runs.get(run.id))?.steps[0]).toMatchObject({ output: { fraction: 0.5 }, tokens: run.tokens });
    const complete = new CompleteTextExtractor(() => ({ model: "fake", apiKey: "synthetic-test-credential" }), async () => ({
      engine: "ai-sdk:openai", model: "fake", text: '{"fraction":"wrong"}', content: [], usage: { inputTokens: 12, outputTokens: 3 },
    }));
    const failed = await composition.createRecipeUseCases(db, { registry, extractor: complete }).runRecipe.execute({ recipe: recipe(extraction), trigger });
    expect(failed.tokens).toEqual({ input: 12, output: 3 });
    expect(failed.steps[0]?.status).toBe("failed");
    expect((await create().runs.get(failed.id))?.tokens).toEqual(failed.tokens);
  });

  it("exposes start/resume/read through thin framework actions with real execution and output validation", async () => {
    vi.spyOn(composition, "getRecipeUseCases").mockImplementation(() => create());
    const gated = steps.map((s) => s.id === "reply" ? { ...s, approval: true } : s);
    const paused = await runRecipe.run({ recipe: recipe(gated), trigger, dryRun: false }, { ...context, actionName: "run-recipe" });
    expect(paused.status).toBe("awaiting_approval");
    expect(await getRecipeRun.run({ runId: paused.id }, context)).toEqual(paused);
    expect(runRecipe.chatUI?.renderer).toBe(RUN_CARD_RENDERER);
    expect(getRecipeRun.chatUI?.renderer).toBe(RUN_CARD_RENDERER);
    expect(resumeRecipeRun.chatUI?.renderer).toBe(APPROVAL_CARD_RENDERER);
    const done = await resumeRecipeRun.run({ runId: paused.id, approval: { stepId: "reply", decision: "approve" }, retry: false }, context);
    expect(done.status).toBe("completed");
    expect(await refunds()).toHaveLength(1);
    expect(await replies()).toHaveLength(1);
    await expect(getRecipeRun.run({ runId: "run_absent" }, context)).rejects.toMatchObject({ errorCode: "RUN_NOT_FOUND" });
    await expect(resumeRecipeRun.run({ runId: "run_absent", retry: false }, context)).rejects.toMatchObject({ errorCode: "RUN_NOT_FOUND" });
  });

  it("keeps run-recipe discoverable as an agent tool without weakening DSL / trigger validation", () => {
    const schema = z.object({ recipe: recipeVersionInputSchema, trigger: recipeJsonInputSchema, dryRun: booleanFlagSchema.default(false) });
    expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
    expect(schema.parse({ recipe: recipe(), trigger }).recipe).toEqual(recipe());
    expect(schema.safeParse({ recipe: { ...recipe(), steps: [{ id: "bad", kind: "action", action: "tag-request", args: { tag: { mode: "path", path: "steps.missing.output.tag" } } }] }, trigger }).success).toBe(false);
    expect(schema.safeParse({ recipe: recipe(), trigger: { invalid: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(schema.safeParse({ recipe: recipe(), trigger: JSON.parse('{"__proto__":{}}') }).success).toBe(false);
  });

  it("lists detached run summaries with combined filters, linked request subjects and stable newest ordering", async () => {
    vi.spyOn(composition, "getRecipeUseCases").mockImplementation(() => create());
    const gated = await create().runRecipe.execute({ recipe: recipe([{ ...steps[0]!, approval: true }], "ver_list_gate"), trigger });
    const dry = await create().runRecipe.execute({ recipe: recipe(steps, "ver_list_dry"), trigger: { id: request.id, orderId: order.id }, mode: "dry-run" });
    const generic = await create().runRecipe.execute({ recipe: recipe([steps[0]!], "ver_list_generic"), trigger: { orderId: order.id } });
    const rows = await listRecipeRuns.run({}, context);
    expect(listRecipeRuns.readOnly).toBe(true);
    expect(listRecipeRuns.http).toMatchObject({ method: "GET" });
    expect(rows.map(run => run.id)).toEqual([generic.id, dry.id, gated.id]);
    expect(rows.find(run => run.id === gated.id)).toMatchObject({ requestId: request.id, requestSubject: request.subject, recipeId: gated.recipe.recipeId, recipeVersionId: gated.recipe.id, version: 1, status: "awaiting_approval", tokens: { input: 0, output: 0 } });
    expect(rows.find(run => run.id === generic.id)?.requestId).toBeNull();
    expect(rows.find(run => run.id === dry.id)?.requestId).toBe(request.id);
    expect(rows[0]).not.toHaveProperty("steps");
    expect(await listRecipeRuns.run({ requestId: request.id, recipeId: gated.recipe.recipeId, status: "awaiting_approval", mode: "execute" }, context)).toEqual([rows.find(run => run.id === gated.id)]);
    expect(await create().runs.list({ status: "completed", requestId: "req_absent" })).toEqual([]);
    expect((await create().runs.list({ mode: "dry-run" }))[0]?.durationMs).toBe(dry.steps.reduce((sum, step) => sum + step.durationMs, 0));
    const summary = rows.find(run => run.id === gated.id)!;
    summary.tokens = { input: 99, output: 0 };
    expect((await create().runs.get(gated.id))?.tokens.input).toBe(0);
  });

  it("runs additive migrations repeatedly without altering recorded checkpoints", async () => {
    const run = await create().runRecipe.execute({ recipe: recipe(), trigger, mode: "dry-run" });
    await withMigrationRuntime(async () => { await migrateApp(undefined); await migrateApp(undefined); });
    expect(await create().runs.get(run.id)).toEqual(run);
    expect(await db.select().from(tables.recipeVersions)).toHaveLength(1);
  });

  it("the resume action explicitly retries a failed real read after the missing order is repaired", async () => {
    vi.spyOn(composition, "getRecipeUseCases").mockImplementation(() => create());
    const missingTrigger = { ...trigger, orderId: "ord_missing" };
    const failed = await runRecipe.run({ recipe: recipe([steps[0]!]), trigger: missingTrigger, dryRun: false }, context);
    expect(failed.status).toBe("handed_off");
    expect(failed.failure?.retryable).toBe(true);
    await db.insert(tables.orders).values({ ...order, id: "ord_missing" });
    const recovered = await resumeRecipeRun.run({ runId: failed.id, retry: true }, context);
    expect(recovered.status).toBe("completed");
    expect(recovered.steps.map((s) => [s.attempt, s.status])).toEqual([[1, "failed"], [2, "completed"]]);
    expect(await getRecipeRun.run({ runId: recovered.id }, context)).toEqual(recovered);
  });
});
