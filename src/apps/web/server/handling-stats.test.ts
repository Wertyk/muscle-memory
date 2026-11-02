import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDbExec, withMigrationRuntime } from "@agent-native/core/db";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { parseRecipeVersion } from "@muscle-memory/recipe-engine";
import { GetHandlingStats } from "@muscle-memory/shop-domain";
import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import getHandlingStats from "../actions/get-handling-stats.js";
import getOrder from "../actions/get-order.js";
import getRequest from "../actions/get-request.js";
import getShipmentStatus from "../actions/get-shipment-status.js";
import issueRefund from "../actions/issue-refund.js";
import sendReply from "../actions/send-reply.js";
import setRequestStatus from "../actions/set-request-status.js";
import tagRequest from "../actions/tag-request.js";
import { DashboardHero } from "../app/components/shop/DashboardHero.js";
import { formatDuration, formatTokens } from "../app/components/shop/dashboard-format.js";
import { dashboardMessages } from "../app/i18n/dashboard-en.js";
import * as composition from "./composition.js";
import { getDb, type ShopDb } from "./db/index.js";
import * as tables from "./db/schema.js";
import {
  damagedItemFixture,
  whereIsMyOrderFixture,
} from "./fixtures/intake-recipes.js";
import { AgentRequestUsage } from "./infra/agent-request-usage.js";
import { demoIntakeScript } from "./infra/demo-intake.js";
import { DrizzleHandlingStats } from "./infra/handling-stats.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { seedShop } from "./infra/shop-demo-store.js";
import migrateApp from "./plugins/db.js";

const context = {
  caller: "frontend" as const,
  userEmail: "operator@example.test",
  orgId: "shop",
};
const owner = { userId: context.userEmail, workspaceId: "shop" };
vi.mock("@agent-native/core/client/i18n", () => ({
  useT: () => (key: string, values: Record<string, unknown> = {}) =>
    String(dashboardMessages[key.replace("dashboard.", "") as keyof typeof dashboardMessages] ?? key)
      .replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? "")),
}));
const agent = (runId: string) => ({
  ...context,
  caller: "tool" as const,
  runId,
  threadId: `thread_${runId}`,
  toolCallId: `call_${runId}`,
});

describe("measured handling dashboard: real intake, executor and actions on PGlite", () => {
  let directory: string;
  let db: ShopDb;
  let sequence = 0;
  const extract = vi.fn(async () => ({
    output: { type: "where_is_my_order", orderId: "ord_1042" },
    tokens: { input: 12, output: 8 },
  }));
  const registry = new RegistryActionInvoker(async () =>
    loadActionsFromStaticRegistry({
      "get-order": { default: getOrder },
      "get-shipment-status": { default: getShipmentStatus },
      "issue-refund": { default: issueRefund },
      "send-reply": { default: sendReply },
      "tag-request": { default: tagRequest },
    }),
  );
  const create = () =>
    composition.createRequestIntake(db, {
      context,
      registry,
      extractor: { extract },
      ids: { next: () => `run_stats${++sequence}` },
    });
  const stats = () =>
    new GetHandlingStats(new DrizzleHandlingStats(db, owner)).execute();
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "muscle-memory-dashboard-"));
    vi.stubEnv("DATABASE_URL", `pglite:${directory}`);
    await withMigrationRuntime(async () => {
      await migrateApp(undefined);
    });
    db = getDb();
  }, 30_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await seedShop(db, { all: true });
    extract.mockReset();
    extract.mockResolvedValue({
      output: { type: "where_is_my_order", orderId: "ord_1042" },
      tokens: { input: 12, output: 8 },
    });
  });
  afterAll(async () => {
    await closeDbExec();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function activate() {
    const cases = create();
    for (const recipe of [damagedItemFixture, whereIsMyOrderFixture]) {
      await cases.catalog.saveVersion(recipe);
      await cases.catalog.save({
        id: recipe.recipeId,
        name: recipe.name,
        status: "active",
        activeVersionId: recipe.id,
      });
    }
    return cases;
  }
  // Only test fixtures write usage: production always reads framework instrumentation.
  async function usage(
    runId: string,
    tokens = 100,
    values: {
      totalOutputTokens?: number;
      userId?: string;
      threadId?: string;
      createdAt?: number;
    } = {},
  ) {
    // Fixture rows use the actual framework-migrated schema, never production inserts.
    await db.execute(sql`INSERT INTO agent_trace_summaries
      (run_id, thread_id, user_id, org_id, llm_calls, total_duration_ms, total_input_tokens, total_output_tokens, created_at)
      VALUES (${runId}, ${values.threadId ?? `thread_${runId}`}, ${values.userId ?? owner.userId}, ${owner.workspaceId}, 1, 123, ${tokens}, ${values.totalOutputTokens ?? 10}, ${values.createdAt ?? Date.now()})
      ON CONFLICT (run_id) DO UPDATE SET total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens, user_id = excluded.user_id`);
  }

  it("reads before any agent turn exists and never turns seed resolutions into measured handling", async () => {
    const data = await stats();
    expect(data.handled).toBe(0);
    expect(data.deterministic).toBe(0);
    expect(data.samples).toEqual([]);
    expect(data).toMatchObject({ pendingApprovals: 0, activeRecipes: 0 });
    expect(getHandlingStats.readOnly).toBe(true);
    await expect(getHandlingStats.run({}, { caller: "cli" })).rejects.toThrow(
      "Sign in",
    );
  });
  it("derives token totals, active milliseconds and live counts from real saved executions without mutating them", async () => {
    const cases = await activate();
    const created = await cases.demo.execute();
    const before = await db.select().from(tables.recipeRuns);
    const data = await getHandlingStats.run({}, context);
    expect(data).toMatchObject({
      deterministic: 2,
      pendingApprovals: 1,
      activeRecipes: 2,
    });
    const outcomes = data.samples.filter((s) =>
      created.some((r) => r.id === s.requestId),
    );
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((s) => s.agentTokens === null)).toBe(true);
    expect(outcomes.find((s) => s.requestId === created[2]!.id)?.tokens).toBe(
      20,
    );
    const saved = (
      await db
        .select()
        .from(tables.requestProcessing)
        .where(eq(tables.requestProcessing.requestId, created[2]!.id))
    )[0]!;
    const run = before.find((r) => r.id === saved.runId)!.checkpoint;
    expect(
      outcomes.find((s) => s.requestId === saved.requestId)?.durationMs,
    ).toBe(
      saved.matchDurationMs! + run.steps.reduce((n, s) => n + s.durationMs, 0),
    );
    expect(await db.select().from(tables.recipeRuns)).toEqual(before);
    expect(extract).toHaveBeenCalledTimes(1);
    await cases.intake.process(created[2]!.id);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .select()
          .from(tables.requestProcessing)
          .where(eq(tables.requestProcessing.requestId, saved.requestId))
      )[0]?.matchDurationMs,
    ).toBe(saved.matchDurationMs);
  });
  it("links the non-mutating request-read turn directly, then charges both turns once after resolution", async () => {
    const cases = await activate();
    const recipeRequest = await cases.intake.create(demoIntakeScript[0]!);
    await getRequest.run({ requestId: "req_0001" }, agent("agent_read"));
    await usage("agent_read", 100);
    // The first turn read the request and could ask a question, with no shop mutation.
    expect(
      (await stats()).samples.some((s) => s.requestId === "req_0001"),
    ).toBe(false);
    expect(
      await db
        .select()
        .from(tables.requestAgentRuns)
        .where(eq(tables.requestAgentRuns.requestId, "req_0001")),
    ).toMatchObject([{ runId: "agent_read", resolvedAt: null }]);
    await setRequestStatus.run(
      { requestId: "req_0001", status: "resolved" },
      agent("agent_resolve"),
    );
    await usage("agent_resolve", 200);
    const data = await stats();
    expect(data.samples.find((s) => s.requestId === "req_0001")).toMatchObject({
      handler: "agent",
      agentTokens: 320,
      tokens: 320,
      durationMs: 246,
    });
    expect(
      data.samples.find((s) => s.requestId === recipeRequest.id),
    ).toMatchObject({ handler: "recipe", tokens: 0 });
    const comparison = data.comparisons.find(
      (c) => c.requestType === "damaged_item",
    )!;
    expect(comparison.agent).toMatchObject({
      tokenSamples: 1,
      meanTokens: 320,
      meanDurationMs: 246,
    });
    expect(comparison.recipe).toMatchObject({ tokenSamples: 1, meanTokens: 0 });
    const foreign = await new GetHandlingStats(
      new DrizzleHandlingStats(db, { ...owner, workspaceId: "foreign" }),
    ).execute();
    expect(
      foreign.samples.find((s) => s.requestId === "req_0001"),
    ).toBeUndefined();
    await setRequestStatus.run(
      { requestId: "req_0001", status: "open" },
      context,
    );
    expect(
      (await stats()).samples.some((s) => s.requestId === "req_0001"),
    ).toBe(false);
  });
  it("renders hero figures equal to the seeded fixture's stored trace and intake/run-step measurements", async () => {
    const cases = await activate();
    await cases.demo.execute();
    await setRequestStatus.run({ requestId: "req_0001", status: "resolved" }, agent("hero_measured"));
    await usage("hero_measured", 94_990);
    const runsBefore = await db.select().from(tables.recipeRuns);
    const processing = await db.select().from(tables.requestProcessing);
    const [trace] = await db.select({
      tokens: sql<number>`total_input_tokens + total_output_tokens`,
      ms: sql<number>`total_duration_ms`,
    }).from(sql`agent_trace_summaries`).where(sql`run_id = 'hero_measured'`);
    const completed = processing.flatMap(record => {
      const run = runsBefore.find(run => run.id === record.runId)?.checkpoint;
      if (run?.status !== "completed" || run.mode !== "execute") return [];
      return [{
        requestId: record.requestId,
        tokens: record.match!.tokens.input + record.match!.tokens.output + run.tokens.input + run.tokens.output,
        ms: record.matchDurationMs! + run.steps.reduce((sum, step) => sum + step.durationMs, 0),
        recipe: { name: run.recipe.name, version: run.recipe.version },
      }];
    });
    expect(completed).toHaveLength(3);
    const meanTokens = completed.reduce((sum, row) => sum + row.tokens, 0) / completed.length;
    const meanMs = completed.reduce((sum, row) => sum + row.ms, 0) / completed.length;
    const data = await getHandlingStats.run({}, context);
    for (const stored of completed) expect(data.samples.find(sample => sample.requestId === stored.requestId)).toMatchObject({
      tokens: stored.tokens, durationMs: stored.ms, recipe: stored.recipe,
    });
    expect(data.samples.find(sample => sample.handler === "agent")?.recipe).toBeNull();
    const html = renderToStaticMarkup(createElement(DashboardHero, { overall: data.overall }));
    expect([...html.matchAll(/data-measurement="([^"]+)"/g)].map(match => Number(match[1]))).toEqual([
      Number(trace!.tokens), Number(trace!.ms), meanTokens, meanMs,
    ]);
    expect([...html.matchAll(/class="sr-only">([^<]+)</g)].map(match => match[1])).toEqual([
      "95K tokens", "123 ms", `${formatTokens(meanTokens)} tokens`, formatDuration(meanMs),
    ]);
    expect(data.overall.recipe.tokenSamples).toBe(completed.length);
    expect(html).toContain(`${formatTokens(Number(trace!.tokens) - meanTokens)}</strong> tokens avoided per request`);
    expect(await db.select().from(tables.recipeRuns)).toEqual(runsBefore);
  });
  it("adds extract-step usage to intake usage and excludes real dry-run checkpoints", async () => {
    const cases = create();
    const recipe = parseRecipeVersion({
      ...whereIsMyOrderFixture,
      id: "ver_stats_extract",
      version: 2,
      steps: [
        {
          id: "extract",
          kind: "extract",
          text: { mode: "fixed", value: "Read the shipment request" },
          fields: {
            type: {
              type: "string",
              required: true,
              description: "Request type",
            },
            orderId: {
              type: "string",
              required: true,
              description: "Order ID",
            },
          },
        },
        ...whereIsMyOrderFixture.steps,
      ],
    });
    await cases.catalog.saveVersion(recipe);
    await cases.catalog.save({
      id: recipe.recipeId,
      name: recipe.name,
      status: "active",
      activeVersionId: recipe.id,
    });
    const freeText = await cases.intake.create(demoIntakeScript[2]!);
    const structured = await cases.intake.create({
      ...demoIntakeScript[2]!,
      content: {
        source: "structured",
        fields: { type: "where_is_my_order", orderId: "ord_1042" },
      },
    });
    const simulated = await composition
      .createRecipeUseCases(db, { context, registry, extractor: { extract } })
      .runRecipe.execute({
        recipe,
        trigger: { requestId: "req_0001", orderId: "ord_1042" },
        mode: "dry-run",
      });
    await db
      .insert(tables.requestProcessing)
      .values({ requestId: "req_0001", runId: simulated.id });
    await setRequestStatus.run(
      { requestId: "req_0001", status: "resolved" },
      context,
    );
    const data = await stats();
    expect(data.handled).toBe(2);
    expect(data.samples.find((s) => s.requestId === freeText.id)?.tokens).toBe(
      40,
    );
    expect(
      data.samples.find((s) => s.requestId === structured.id)?.tokens,
    ).toBe(20);
    expect(data.samples.find((s) => s.requestId === freeText.id)).toMatchObject(
      { intakeTokens: 20, runTokens: 20 },
    );
    expect(
      data.samples.find((s) => s.requestId === structured.id),
    ).toMatchObject({ intakeTokens: 0, runTokens: 20 });
    expect(data.deterministic).toBe(0);
    expect(simulated.mode).toBe("dry-run");
  });
  it("includes intervening thread turns once, without unrelated earlier/later or foreign usage", async () => {
    const threadId = "thread_window";
    await getRequest.run(
      { requestId: "req_0001" },
      { ...agent("window_first"), threadId },
    );
    await setRequestStatus.run(
      { requestId: "req_0001", status: "resolved" },
      { ...agent("window_last"), threadId },
    );
    await usage("window_first", 100, { threadId, createdAt: 2000 });
    await usage("window_middle", 50, { threadId, createdAt: 3000 });
    await usage("window_last", 200, { threadId, createdAt: 4000 });
    await usage("window_before", 1000, { threadId, createdAt: 1000 });
    await usage("window_after", 1000, { threadId, createdAt: 5000 });
    await usage("window_foreign", 1000, {
      threadId,
      createdAt: 3000,
      userId: "other@example.test",
    });
    expect(
      (await stats()).samples.find((s) => s.requestId === "req_0001"),
    ).toMatchObject({ handler: "agent", tokens: 380, durationMs: 369 });
  });
  it("keeps overlapping request windows unknown even when the individual action runs differ", async () => {
    const threadId = "thread_overlapping";
    for (const requestId of ["req_0001", "req_0002"] as const)
      await setRequestStatus.run({ requestId, status: "open" }, context);
    await getRequest.run(
      { requestId: "req_0001" },
      { ...agent("overlap_a_first"), threadId },
    );
    await getRequest.run(
      { requestId: "req_0002" },
      { ...agent("overlap_b_first"), threadId },
    );
    await setRequestStatus.run(
      { requestId: "req_0001", status: "resolved" },
      { ...agent("overlap_a_last"), threadId },
    );
    await setRequestStatus.run(
      { requestId: "req_0002", status: "resolved" },
      { ...agent("overlap_b_last"), threadId },
    );
    for (const [runId, createdAt] of [
      ["overlap_a_first", 1000],
      ["overlap_b_first", 2000],
      ["overlap_a_last", 3000],
      ["overlap_b_last", 4000],
    ] as const)
      await usage(runId, 100, { threadId, createdAt });
    const data = await stats();
    for (const id of ["req_0001", "req_0002"])
      expect(data.samples.find((s) => s.requestId === id)).toMatchObject({
        handler: "agent",
        agentTokens: null,
        tokens: null,
        durationMs: null,
      });
  });
  it("keeps the first dashboard read safe if observability tables are not initialized", async () => {
    await setRequestStatus.run(
      { requestId: "req_0001", status: "resolved" },
      agent("not_initialized"),
    );
    await db.execute(
      sql`ALTER TABLE agent_trace_summaries RENAME TO task21_uninitialized_traces`,
    );
    try {
      expect(
        (await stats()).samples.find((s) => s.requestId === "req_0001"),
      ).toMatchObject({
        handler: "agent",
        agentTokens: null,
        tokens: null,
        durationMs: null,
      });
    } finally {
      await db.execute(
        sql`ALTER TABLE task21_uninitialized_traces RENAME TO agent_trace_summaries`,
      );
    }
  });
  it("keeps missing, placeholder-zero, cross-owner and shared-turn tokens unknown", async () => {
    for (const [requestId, runId] of [
      ["req_0001", "missing"],
      ["req_0002", "zero"],
      ["req_0003", "foreign"],
      ["req_0004", "shared"],
      ["req_0005", "shared"],
    ] as const) {
      await setRequestStatus.run(
        { requestId, status: "resolved" },
        agent(runId),
      );
    }
    await usage("zero", 0, { totalOutputTokens: 0 });
    await usage("foreign", 20, { userId: "someone@example.test" });
    await usage("shared");
    const data = await stats();
    for (const id of [
      "req_0001",
      "req_0002",
      "req_0003",
      "req_0004",
      "req_0005",
    ]) {
      expect(data.samples.find((s) => s.requestId === id)).toMatchObject({
        handler: "agent",
        agentTokens: null,
        tokens: null,
      });
    }
    expect(
      data.samples.find((s) => s.requestId === "req_0004")?.durationMs,
    ).toBeNull();
    expect(data.deterministic).toBe(0);
  });
  it("includes intake extraction and recipe work before agent resolution, preserves unknown legacy timing", async () => {
    const cases = create(); // no active recipe -> real fallback handoff
    const request = await cases.intake.create(demoIntakeScript[2]!);
    expect(
      (await stats()).samples.some((s) => s.requestId === request.id),
    ).toBe(false);
    await getRequest.run({ requestId: request.id }, agent("handoff"));
    await setRequestStatus.run(
      { requestId: request.id, status: "resolved" },
      agent("handoff"),
    );
    await usage("handoff");
    expect(
      (await stats()).samples.find((s) => s.requestId === request.id),
    ).toMatchObject({ handler: "agent", tokens: 130 });
    await db
      .update(tables.requestProcessing)
      .set({ matchDurationMs: null })
      .where(eq(tables.requestProcessing.requestId, request.id));
    expect(
      (await stats()).samples.find((s) => s.requestId === request.id)
        ?.durationMs,
    ).toBeNull();
  });
  it("does not claim zero tokens for failed extraction or agent-touched recipe handling; cleanup drops associations", async () => {
    const cases = await activate();
    extract.mockRejectedValueOnce(new Error("Offline provider failed"));
    const request = await cases.intake.create(demoIntakeScript[2]!);
    await setRequestStatus.run(
      { requestId: request.id, status: "resolved" },
      agent("failed_extract"),
    );
    await usage("failed_extract");
    expect(
      (await stats()).samples.find((s) => s.requestId === request.id)?.tokens,
    ).toBeNull();
    const completed = await cases.intake.create(demoIntakeScript[0]!);
    await getRequest.run({ requestId: completed.id }, agent("inspection"));
    expect(
      (await stats()).samples.find((s) => s.requestId === completed.id),
    ).toMatchObject({ handler: "recipe", tokens: null });
    const captured = await db.select().from(tables.requestAgentRuns);
    expect(captured.length).toBeGreaterThan(0);
    await seedShop(db);
    expect(await db.select().from(tables.requestAgentRuns)).toEqual([]);
    expect((await stats()).activeRecipes).toBe(2);
  });
  it("ignores deterministic recipe invocations as agent turns and never repeats a successful effect on telemetry failure", async () => {
    const usageAdapter = new AgentRequestUsage(db);
    await usageAdapter.succeeded(
      {
        actionName: "get-request",
        input: { requestId: "req_0001" },
        output: {},
      },
      { ...agent("run_recipe"), toolCallId: "run_recipe:step" },
    );
    expect(await db.select().from(tables.requestAgentRuns)).toEqual([]);
    vi.spyOn(AgentRequestUsage.prototype, "succeeded").mockRejectedValueOnce(
      new Error("Offline telemetry failure"),
    );
    const result = await tagRequest.run(
      { requestId: "req_0001", tag: "measured" },
      agent("telemetry_failure"),
    );
    expect(result.tags).toContain("measured");
    expect(
      (await getRequest.run({ requestId: "req_0001" }, context)).tags.filter(
        (t) => t === "measured",
      ),
    ).toHaveLength(1);
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tables.requests);
    expect(count[0]?.n).toBe(60);
  });
});
