import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import {
  closeDbExec,
  getDbExec,
  withMigrationRuntime,
} from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server";
import {
  buildRequestTrigger,
  MatchRequest,
  Demonstrations,
  parseRecipeVersion,
  type JsonObject,
} from "@muscle-memory/recipe-engine";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import cancel from "../actions/cancel-demonstration.js";
import getCustomer from "../actions/get-customer.js";
import get from "../actions/get-demonstration.js";
import getOrder from "../actions/get-order.js";
import getActivity from "../actions/get-request-activity.js";
import getRequest from "../actions/get-request.js";
import getShipment from "../actions/get-shipment-status.js";
import issueRefund from "../actions/issue-refund.js";
import listRequests from "../actions/list-requests.js";
import sendReply from "../actions/send-reply.js";
import start from "../actions/start-demonstration.js";
import stop from "../actions/stop-demonstration.js";
import tag from "../actions/tag-request.js";
import setStatus from "../actions/set-request-status.js";
import getAgentTrace from "../actions/get-agent-run-demonstration.js";
import draftRecipe from "../actions/draft-recipe-from-demonstration.js";
import { traced } from "./infra/traced.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import { demonstrations, demoSteps, recipes, recipeVersions, requestProcessing, requests } from "./db/schema.js";
import { createShopDemoData, DEMO_NOW } from "./db/shop-demo-data.js";
import { resetShop, seedShop } from "./infra/shop-demo-store.js";
import { damagedItemFixture } from "./fixtures/intake-recipes.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import migrate from "./plugins/db.js";

const fixtures = createShopDemoData(DEMO_NOW);
const request = fixtures.requests.find(
  (r) =>
    r.content.source === "structured" &&
    r.content.fields.type === "damaged_item" &&
    r.status === "open",
)!;
const order = fixtures.orders.find((o) => o.id === request.orderId)!;
const context = {
  caller: "frontend" as const,
  userEmail: "operator@example.test",
};
function session<T>(
  work: () => Promise<T>,
  userEmail = context.userEmail,
  tab = "teach_a",
  orgId = "shop",
) {
  return runWithRequestContext(
    { userEmail, orgId, run: { browserTabId: tab } },
    work,
  );
}
async function navigation(id = request.id) {
  await writeAppStateForCurrentTab("navigation", {
    view: "request",
    requestId: id,
    path: `/requests/${id}`,
  });
}

describe("Teach with real actions and PGlite", () => {
  let directory: string;
  let db: ShopDb;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-teach-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    vi.stubEnv("SHOP_DEMO_ANCHOR", DEMO_NOW);
    await withMigrationRuntime(async () => {
      await migrate(undefined);
    });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    await seedShop(db, { all: true });
    await session(() => navigation());
  });

  it.each(["seed", "reset"] as const)("%s after Teach clears headers and captured steps while retaining active recipes", async command =>
    session(async () => {
      const catalog = composition.createRequestIntake(db).catalog;
      await catalog.saveVersion(damagedItemFixture);
      await catalog.save({ id: damagedItemFixture.recipeId, name: damagedItemFixture.name, status: "active", activeVersionId: damagedItemFixture.id });
      const expectedCatalog = await db.select().from(recipes).orderBy(recipes.id);
      const expectedVersions = await db.select().from(recipeVersions).orderBy(recipeVersions.id);
      const demo = await start.run({ requestId: request.id }, context);
      await getRequest.run({ requestId: request.id }, context);
      await tag.run({ requestId: request.id, tag: "rehearsal" }, context);
      const saved = await stop.run({ demonstrationId: demo.id }, context);
      expect(saved.status).toBe("completed");
      expect(saved.steps.map(step => step.action)).toEqual(["get-request", "tag-request"]);
      expect(await db.select().from(demoSteps)).toHaveLength(2);
      if (command === "seed") await seedShop(db);
      else await resetShop(db);
      expect(await db.select().from(demonstrations)).toEqual([]);
      expect(await db.select().from(demoSteps)).toEqual([]);
      expect(await get.run({ demonstrationId: demo.id }, context)).toBeNull();
      expect(await db.select().from(recipes).orderBy(recipes.id)).toEqual(expectedCatalog);
      expect(await db.select().from(recipeVersions).orderBy(recipeVersions.id)).toEqual(expectedVersions);
      if (command === "reset") await seedShop(db);
      const next = await start.run({ requestId: request.id }, context);
      expect(next.id).not.toBe(demo.id);
      expect(next.status).toBe("recording");
      await stop.run({ demonstrationId: next.id }, context);
    }));
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const agent = { caller: "tool" as const, userEmail: context.userEmail, runId: "run_agent_first", threadId: "thread_agent", toolCallId: "call_first" };
  async function unmatched() {
    const trigger = buildRequestTrigger(request.content.source === "structured" ? request.content.fields as unknown as JsonObject : {},
      { requestId: request.id, customerId: request.customerId, subject: request.subject });
    await db.insert(requestProcessing).values({ requestId: request.id, runId: "run_intake_agent", match: {
      trigger, recipe: null, reason: "no_match", tokens: { input: 0, output: 0 },
    } });
  }
  it.each(["seed", "no_match", "handed_off", "completed", "completed_manual", "dry_run", "unknown", "extraction_failed"])("agent trace eligibility for %s requests", async scenario => session(async () => {
    const trigger = buildRequestTrigger(request.content.source === "structured" ? request.content.fields as unknown as JsonObject : {},
      { requestId: request.id, customerId: request.customerId, subject: request.subject });
    if (scenario === "no_match" || scenario === "extraction_failed") await unmatched();
    if (["handed_off", "completed", "completed_manual", "dry_run"].includes(scenario)) {
      const recipe = parseRecipeVersion({ ...damagedItemFixture, id: "ver_trace_eligibility", recipeId: "recipe_trace_eligibility",
        steps: scenario === "handed_off"
          ? [{ id: "handoff", kind: "handoff", to: "agent", note: { mode: "fixed", value: "Agent must handle this request" } }]
          : [{ id: "request", kind: "action", action: "get-request", args: { requestId: { mode: "path", path: "trigger.requestId" } } }],
      });
      const run = await composition.createRecipeUseCases(db).runRecipe.execute({ recipe, trigger, mode: scenario === "dry_run" ? "dry-run" : "execute" });
      expect(run.status).toBe(scenario === "handed_off" ? "handed_off" : "completed");
      if (scenario === "handed_off" || scenario === "completed")
        await db.insert(requestProcessing).values({ requestId: request.id, runId: run.id,
          match: { trigger, recipe, reason: "matched", tokens: { input: 0, output: 0 } } });
    }
    await getRequest.run({ requestId: request.id }, agent);
    if (scenario === "unknown" || scenario === "extraction_failed") {
      // Keep a valid recorded trace, but simulate missing/failed type classification.
      await db.update(requests).set({ content: { source: "free_text", text: "Please help with my order.", type: null } }).where(eq(requests.id, request.id));
      if (scenario === "extraction_failed")
        await db.update(requestProcessing).set({ match: { trigger, recipe: null, reason: "extraction_failed", tokens: { input: 0, output: 0 } } }).where(eq(requestProcessing.requestId, request.id));
    }
    await sendReply.run({ requestId: request.id, template: "Handled by the agent", variables: {} }, agent);
    await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
    const captured = (await composition.getTeachUseCases().demonstrations.current({ userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` }, request.id))!;
    expect(captured.status).toBe("completed");
    const eligible = await getAgentTrace.run({ requestId: request.id }, context);
    if (["seed", "no_match", "handed_off", "dry_run"].includes(scenario)) {
      expect(eligible?.id).toBe(captured.id);
      expect((await draftRecipe.run({ demonstrationId: eligible!.id }, context)).demonstrationId).toBe(captured.id);
    } else expect(eligible).toBeNull();
  }));
  it("captures agent first reads across question-only turns, omits failures and drafts the completed resolution through the same pipeline", async () => session(async () => {
    await unmatched();
    await tag.run({ requestId: request.id, tag: "before-capture" }, context);
    await Promise.all([getRequest.run({ requestId: request.id }, agent), getOrder.run({ orderId: order.id }, agent),
      getOrder.run({ orderId: order.id }, agent)]);
    const demos = composition.getTeachUseCases().demonstrations;
    const scope = { userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` };
    const questioning = (await demos.current(scope, request.id))!;
    expect(questioning.status).toBe("recording");
    expect(questioning.steps.map(s => s.action)).toEqual(["get-request", "get-order"]);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
    const second = { ...agent, runId: "run_agent_second", toolCallId: "call_second" };
    await expect(traced("tag-request", async () => { throw new Error("rejected"); }, composition.shopTraceCapture)({ requestId: request.id, tag: "failed" }, second)).rejects.toThrow("rejected");
    await getOrder.run({ orderId: order.id }, second);
    const reply = await sendReply.run({ requestId: request.id, template: "Handled", variables: {} }, second);
    await tag.run({ requestId: request.id, tag: "agent-handled" }, second);
    await setStatus.run({ requestId: request.id, status: "resolved" }, second);
    const trace = (await getAgentTrace.run({ requestId: request.id }, context))!;
    expect(trace.status).toBe("completed");
    expect(trace.source).toEqual({ kind: "agent_run", threadId: agent.threadId, runIds: [agent.runId, second.runId] });
    expect(trace.pending).toEqual([]);
    expect(trace.steps.slice(0, 2)).toEqual(questioning.steps);
    expect(trace.steps.map(s => s.action)).toEqual(["get-request", "get-order", "send-reply", "tag-request", "set-request-status"]);
    expect(trace.steps[2]).toMatchObject({ input: { requestId: request.id, template: "Handled", variables: {} }, output: reply, runId: second.runId, caller: "tool" });
    expect(trace.steps.every(s => s.durationMs >= 0 && s.navigation !== null)).toBe(true);
    await tag.run({ requestId: request.id, tag: "reviewed-after-resolution" }, context);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toEqual(trace);
    const result = await draftRecipe.run({ demonstrationId: trace.id }, context);
    expect(result.demonstrationId).toBe(trace.id);
    expect(result.draft.steps.some(s => s.kind === "action" && s.action === "set-request-status")).toBe(true);
    await expect(stop.run({ demonstrationId: trace.id }, context)).rejects.toMatchObject({ errorCode: "TEACH_INPUT" });
    await session(async () => expect(await getAgentTrace.run({ requestId: request.id }, { ...context, userEmail: "other@example.test" })).toBeNull(), "other@example.test");
    await session(async () => expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull(), context.userEmail, "other", "other-shop");
    await db.update(requestProcessing).set({ match: { trigger: trace.trigger, recipe: damagedItemFixture, reason: "matched", tokens: { input: 0, output: 0 } } });
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
  }));

  it("isolates agent request/thread/owner references and excludes recipe, frontend and historical calls", async () => session(async () => {
    await unmatched();
    await writeAppStateForCurrentTab("navigation", { view: "inbox" });
    await getOrder.run({ orderId: order.id }, agent); // No request scope yet: never backfilled.
    await navigation();
    await getRequest.run({ requestId: request.id }, agent);
    const other = fixtures.requests.find(r => r.id !== request.id && r.orderId && r.orderId !== order.id && r.customerId !== request.customerId)!;
    await getRequest.run({ requestId: other.id }, agent);
    await getOrder.run({ orderId: other.orderId! }, agent);
    await getCustomer.run({ customerId: other.customerId }, agent);
    await listRequests.run({}, agent);
    expect(await composition.shopTraceCapture.recording(agent, { actionName: "create-request", input: { customerId: request.customerId } })).toBeNull();
    await getOrder.run({ orderId: order.id }, { ...agent, toolCallId: `${agent.runId}:recipe-step` });
    await getOrder.run({ orderId: order.id }, { ...agent, threadId: "other-thread" });
    await getOrder.run({ orderId: order.id }, { ...agent, userEmail: "other@example.test" });
    await getOrder.run({ orderId: order.id }, context);
    await navigation(other.id); // Agent recording is independent of a moving browser tab.
    await getCustomer.run({ customerId: request.customerId }, agent);
    await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
    const trace = (await getAgentTrace.run({ requestId: request.id }, context))!;
    expect(trace.steps.map(s => s.action)).toEqual(["get-request", "get-customer", "set-request-status"]);
    await getOrder.run({ orderId: order.id }, agent);
    expect(await get.run({ demonstrationId: trace.id }, context)).toEqual(trace);
  }));

  it("never completes on human resolution and hides superseded agent resolutions", async () => session(async () => {
    await unmatched();
    await getRequest.run({ requestId: request.id }, agent);
    await setStatus.run({ requestId: request.id, status: "resolved" }, context);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
    const demo = (await composition.getTeachUseCases().demonstrations.active({ userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` }))!;
    expect(demo.status).toBe("recording");
    await expect(draftRecipe.run({ demonstrationId: demo.id }, context)).rejects.toMatchObject({ errorCode: "DRAFT_INPUT" });
    await setStatus.run({ requestId: request.id, status: "open" }, context);
    await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).not.toBeNull();
    await setStatus.run({ requestId: request.id, status: "open" }, context);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
  }));

  it("keeps an agent resolution incomplete when capture is interrupted", async () => session(async () => {
    await unmatched();
    await getRequest.run({ requestId: request.id }, agent);
    const demos = composition.getTeachUseCases().demonstrations;
    const scope = { userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` };
    await demos.begin({ scope, subjectId: request.id, references: {} });
    await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
    const demo = (await demos.current(scope, request.id))!;
    expect(demo.status).toBe("incomplete");
    expect(demo.pending).toHaveLength(1);
    expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
    await expect(draftRecipe.run({ demonstrationId: demo.id }, context)).rejects.toMatchObject({ errorCode: "DRAFT_INPUT" });
  }));

  it("omits failed agent capture and never claims completion after a successful shop effect was lost", async () => session(async () => {
    await unmatched();
    await getRequest.run({ requestId: request.id }, agent);
    await getDbExec().execute(`CREATE FUNCTION reject_agent_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'action' = 'tag-request' THEN RAISE EXCEPTION 'private capture failure'; END IF; RETURN NEW; END $$;`);
    await getDbExec().execute("CREATE TRIGGER reject_agent_capture BEFORE INSERT ON demo_steps FOR EACH ROW EXECUTE FUNCTION reject_agent_capture()");
    try {
      const result = await tag.run({ requestId: request.id, tag: "agent-capture-failure" }, agent);
      expect(result.tags).toContain("agent-capture-failure");
      await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
      const trace = (await composition.getTeachUseCases().demonstrations.current({ userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` }, request.id))!;
      expect(trace.status).toBe("incomplete");
      expect(trace.incompleteReason).toContain("tag-request");
      expect(trace.steps.map(s => s.action)).toEqual(["get-request"]);
      expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
    } finally {
      await getDbExec().execute("DROP TRIGGER reject_agent_capture ON demo_steps");
      await getDbExec().execute("DROP FUNCTION reject_agent_capture()");
    }
  }));

  it("marks an existing agent trace incomplete when session lookup fails before reserving a successful mutation", async () => session(async () => {
    await unmatched();
    await getRequest.run({ requestId: request.id }, agent);
    const lookup = vi.spyOn(Demonstrations.prototype, "active").mockRejectedValueOnce(new Error("private lookup failure"));
    try {
      const result = await tag.run({ requestId: request.id, tag: "lookup-capture-failure" }, agent);
      expect(result.tags).toContain("lookup-capture-failure");
      await setStatus.run({ requestId: request.id, status: "resolved" }, agent);
      const trace = (await composition.getTeachUseCases().demonstrations.current({ userId: context.userEmail, workspaceId: "shop", sessionId: `agent:${agent.threadId}` }, request.id))!;
      expect(trace.status).toBe("incomplete");
      expect(trace.steps.map(s => s.action)).toEqual(["get-request"]);
      expect(await getAgentTrace.run({ requestId: request.id }, context)).toBeNull();
    } finally { lookup.mockRestore(); }
  }));

  it("stores reads, mutations and exact intake trigger, and retrieves a detached trace from a fresh adapter", async () =>
    session(async () => {
      await tag.run({ requestId: request.id, tag: "before" }, context);
      const demo = await start.run({ requestId: request.id }, context);
      const match = await new MatchRequest({
        recipes: { listActive: async () => [] },
        extractor: {
          extract: async () => {
            throw new Error("no LLM");
          },
        },
      }).execute({
        event: "request.created",
        content: {
          source: "structured",
          fields: (request.content.source === "structured"
            ? request.content.fields
            : {}) as unknown as JsonObject,
        },
        context: {
          requestId: request.id,
          customerId: request.customerId,
          subject: request.subject,
        },
      });
      expect(demo.trigger).toEqual(match.trigger);
      await getRequest.run({ requestId: request.id }, context);
      await getOrder.run({ orderId: order.id }, context);
      await getCustomer.run({ customerId: request.customerId }, context);
      await getShipment.run({ orderId: order.id }, context);
      // Request-scoped list result is eligible; an inbox-wide result is excluded.
      await listRequests.run(
        { customerId: request.customerId, type: "damaged_item" },
        context,
      );
      await sendReply.run(
        {
          requestId: request.id,
          template: "We are taking care of this.",
          variables: {},
        },
        context,
      );
      await tag.run({ requestId: request.id, tag: "taught" }, context);
      const saved = await stop.run({ demonstrationId: demo.id }, context);
      expect(saved.status).toBe("completed");
      expect(saved.steps.map((s) => s.action)).toEqual([
        "get-request",
        "get-order",
        "get-customer",
        "get-shipment-status",
        "list-requests",
        "send-reply",
        "tag-request",
      ]);
      expect(saved.steps[1]).toMatchObject({
        input: { orderId: order.id },
        output: order,
        navigation: { view: "request", requestId: request.id },
        caller: "frontend",
      });
      expect(
        saved.steps.every(
          (s) => Number.isFinite(s.startedAt) && s.durationMs >= 0,
        ),
      ).toBe(true);
      await tag.run({ requestId: request.id, tag: "after" }, context);
      const reloaded = await composition
        .createTeachUseCases(db)
        .get({ demonstrationId: demo.id }, { ...context, caller: "tool" });
      expect(reloaded).toEqual(saved);
      expect(
        await get.run(
          { demonstrationId: demo.id },
          { ...context, caller: "mcp" },
        ),
      ).toEqual(saved);
      expect(await get.run({ requestId: request.id }, context)).toEqual(saved);
      expect(get.readOnly).toBe(true);
      expect(get.http).toEqual({ method: "GET" });
    }));

  it("stores exactly five first lookups plus reply and tag despite every automatic refetch", async () =>
    session(async () => {
      const demo = await start.run({ requestId: request.id }, context);
      const refetch = () =>
        Promise.all([
          getRequest.run({ requestId: request.id }, context),
          getOrder.run({ orderId: order.id }, context),
          getShipment.run({ orderId: order.id }, context),
          getCustomer.run({ customerId: request.customerId }, context),
          getActivity.run({ requestId: request.id }, context),
        ]);
      await refetch();
      const first = (await get.run({ demonstrationId: demo.id }, context))!;
      const reply = await sendReply.run(
        {
          requestId: request.id,
          template: "We have taken care of the chipped platter.",
          variables: {},
        },
        context,
      );
      await refetch();
      await tag.run(
        { requestId: request.id, tag: "teach-dedup-proof" },
        context,
      );
      const current = await refetch();
      expect(current[0].tags).toContain("teach-dedup-proof"); // Reads still return fresh shop state.
      const saved = await stop.run({ demonstrationId: demo.id }, context);
      expect(saved.status).toBe("completed");
      expect(saved.steps).toHaveLength(7);
      expect(saved.steps.slice(0, 5)).toEqual(first.steps);
      expect(saved.steps.slice(5).map((s) => s.action)).toEqual([
        "send-reply",
        "tag-request",
      ]);
      expect(saved.steps[5]?.output).toEqual(reply);
      expect(
        await composition
          .createTeachUseCases(db)
          .get({ demonstrationId: demo.id }, context),
      ).toEqual(saved);
    }));

  it("reconciles persisted concurrent duplicate reads, keeping the first invocation snapshot", async () =>
    session(async () => {
      const demo = await start.run({ requestId: request.id }, context);
      const demos = composition.createTeachUseCases(db).demonstrations;
      const read = { action: "get-order", input: { orderId: order.id } };
      const begin = () =>
        demos.begin({
          scope: demo.scope,
          subjectId: request.id,
          references: { orderId: order.id },
          read,
        });
      const [first, second] = await Promise.all([begin(), begin()]);
      const metadata = {
        ...read,
        navigation: { view: "request", requestId: request.id },
        caller: "frontend",
        durationMs: 5,
      };
      await demos.complete(
        demo.scope,
        second!,
        { ...metadata, output: { snapshot: "second" }, startedAt: 102 },
        "read",
      );
      await demos.complete(
        demo.scope,
        first!,
        { ...metadata, output: { snapshot: "first" }, startedAt: 101 },
        "read",
      );
      const saved = (await get.run({ demonstrationId: demo.id }, context))!;
      expect(saved.steps).toEqual([
        {
          ...metadata,
          output: { snapshot: "first" },
          startedAt: 101,
          id: "step_1",
          sequence: 1,
        },
      ]);
      expect(await begin()).toBeNull();
      await stop.run({ demonstrationId: demo.id }, context);
    }));

  it("isolates users, tabs, workspaces, navigation, unrelated request/order/customer and deterministic recipe calls", async () =>
    session(async () => {
      const demo = await start.run({ requestId: request.id }, context);
      await session(async () => {
        await navigation();
        await tag.run(
          { requestId: request.id, tag: "other-user" },
          { ...context, userEmail: "other@example.test" },
        );
        expect(
          await get.run(
            { demonstrationId: demo.id },
            { ...context, userEmail: "other@example.test" },
          ),
        ).toBeNull();
      }, "other@example.test");
      await session(
        async () => {
          await navigation();
          await getOrder.run({ orderId: order.id }, context);
          expect(await get.run({ requestId: request.id }, context)).toBeNull();
        },
        context.userEmail,
        "teach_b",
      );
      await session(
        async () => {
          await navigation();
          await getOrder.run({ orderId: order.id }, context);
          expect(
            await get.run({ demonstrationId: demo.id }, context),
          ).toBeNull();
        },
        context.userEmail,
        "teach_a",
        "other-shop",
      );
      const other = fixtures.requests.find(
        (r) =>
          r.id !== request.id &&
          r.orderId &&
          r.orderId !== order.id &&
          r.customerId !== request.customerId,
      )!;
      await getRequest.run({ requestId: other.id }, context);
      await getOrder.run({ orderId: other.orderId! }, context);
      await getCustomer.run({ customerId: other.customerId }, context);
      await listRequests.run({}, context);
      await getOrder.run(
        { orderId: order.id },
        { ...context, runId: "run_demo", toolCallId: "run_demo:order" },
      );
      await navigation(other.id);
      await getOrder.run({ orderId: order.id }, context);
      await writeAppStateForCurrentTab("navigation", { view: "inbox" });
      await listRequests.run({}, context);
      expect(
        (await stop.run({ demonstrationId: demo.id }, context)).steps,
      ).toHaveLength(0);
    }));

  it("rejects overlap atomically and cancellation frees the recording slot", async () =>
    session(async () => {
      const results = await Promise.allSettled([
        start.run({ requestId: request.id }, context),
        start.run({ requestId: request.id }, context),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const demo = (await get.run({ requestId: request.id }, context))!;
      expect(
        (await cancel.run({ demonstrationId: demo.id }, context)).status,
      ).toBe("cancelled");
      const next = await start.run({ requestId: request.id }, context);
      expect(next.id).not.toBe(demo.id);
      await stop.run({ demonstrationId: next.id }, context);
    }));

  it("returns a successful refund once when step INSERT fails and persists an incomplete reason (AC #7)", async () =>
    session(async () => {
      const demo = await start.run({ requestId: request.id }, context);
      await getOrder.run({ orderId: order.id }, context);
      const shop = new DrizzleShopRepository(db);
      const before = await shop.listRefundsForOrder(order.id);
      await getDbExec().execute(
        `CREATE FUNCTION reject_refund_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'action' = 'issue-refund' THEN RAISE EXCEPTION 'private database detail'; END IF; RETURN NEW; END $$;`,
      );
      await getDbExec().execute(
        `CREATE TRIGGER reject_refund_capture BEFORE INSERT ON demo_steps FOR EACH ROW EXECUTE FUNCTION reject_refund_capture();`,
      );
      try {
        const output = await issueRefund.run(
          {
            orderId: order.id,
            amount: { amountMinor: 100, currency: "USD" },
            reason: "Teach failure proof",
          },
          context,
        );
        expect(
          (await shop.listRefundsForOrder(order.id)).filter(
            (r) => r.id === output.id,
          ),
        ).toHaveLength(1);
        expect(await shop.listRefundsForOrder(order.id)).toHaveLength(
          before.length + 1,
        );
        const trace = (await get.run({ demonstrationId: demo.id }, context))!;
        expect(trace.status).toBe("incomplete");
        expect(trace.incompleteReason).toContain("issue-refund");
        expect(trace.incompleteReason).not.toContain("private database detail");
        expect(trace.steps.map((s) => s.action)).toEqual(["get-order"]);
        expect(trace.pending).toEqual([2]);
        expect(
          (await stop.run({ demonstrationId: demo.id }, context)).status,
        ).toBe("incomplete");
      } finally {
        await getDbExec().execute(
          "DROP TRIGGER reject_refund_capture ON demo_steps",
        );
        await getDbExec().execute("DROP FUNCTION reject_refund_capture()");
      }
    }));

  it("requires confirmed valid free-text fields and uses the shared trigger shape without a model", async () =>
    session(async () => {
      const freeText = fixtures.requests.find(
        (r) => r.content.source === "free_text" && r.orderId,
      )!;
      await navigation(freeText.id);
      await expect(
        start.run({ requestId: freeText.id }, context),
      ).rejects.toMatchObject({ errorCode: "TEACH_INPUT" });
      const fields = {
        type: "where_is_my_order" as const,
        orderId: freeText.orderId!,
      };
      const demo = await start.run({ requestId: freeText.id, fields }, context);
      expect(demo.trigger).toEqual(
        buildRequestTrigger(fields, {
          requestId: freeText.id,
          customerId: freeText.customerId,
          subject: freeText.subject,
        }),
      );
      await stop.run({ demonstrationId: demo.id }, context);
      await db.insert(requestProcessing).values({
        requestId: freeText.id,
        runId: "run_teach_saved",
        match: {
          trigger: demo.trigger,
          recipe: null,
          reason: "no_match",
          tokens: { input: 0, output: 0 },
        },
      });
      const fromSavedIntake = await start.run(
        { requestId: freeText.id },
        context,
      );
      expect(fromSavedIntake.trigger).toEqual(demo.trigger);
      await stop.run({ demonstrationId: fromSavedIntake.id }, context);
    }));
});
