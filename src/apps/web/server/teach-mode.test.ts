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
  type JsonObject,
} from "@muscle-memory/recipe-engine";
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
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import { demonstrations, demoSteps, recipes, recipeVersions, requestProcessing } from "./db/schema.js";
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
