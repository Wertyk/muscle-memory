// Opt-in HTTP smoke. No browser automation, real model calls, or production data.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildRequestTrigger,
  type Demonstration,
  type JsonObject,
  type RecipeDraft,
  type RecipeVersion,
  type StudioDraft,
  type Run,
} from "@muscle-memory/recipe-engine";
import type { Order, Refund, Request } from "@muscle-memory/shop-domain";
import { Window } from "happy-dom";

const web = fileURLToPath(new URL("../", import.meta.url));
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = "http://localhost:5189";
let stage = "initialization";
async function smoke() {
  assert(
    !(await fetch(`${origin}/_agent-native/ping`).then(
      () => true,
      () => false,
    )),
    "Smoke port must be free",
  );
  const directory = await mkdtemp(`${tmpdir()}/muscle-memory-teach-smoke-`);
  const env = {
    ...process.env,
    DATABASE_URL: `pglite:${directory}/db`,
    NODE_ENV: "development",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_URL: origin,
  };
  let server: ReturnType<typeof spawn> | undefined;
  let dom: Window | undefined;
  const nativeFetch = globalThis.fetch;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const cookies = new Map<string, string>();
  const remember = (r: Response) => {
    for (const value of r.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  };
  try {
    const sourceFixture = JSON.parse(
      await readFile(
        new URL(
          "../server/fixtures/broken-platter-demonstration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Demonstration;
    const fixtureInput = (name: string) => {
      const step = sourceFixture.steps.find((step) => step.action === name);
      assert(step, `Missing stored fixture action ${name}`);
      return step.input;
    };
    const fixtureText = (name: string, argument: string) => {
      const value = fixtureInput(name)[argument];
      assert(typeof value === "string", "Expected a text fixture argument");
      return value;
    };
    stage = "seed and start";
    await exec("pnpm", ["-C", workspace, "seed:shop"], {
      env,
      timeout: 60_000,
      maxBuffer: 1_000_000,
    });
    await exec(
      "pnpm",
      [
        "-C",
        web,
        "exec",
        "tsx",
        "scripts/teach-mode-smoke.ts",
        "--seed-recipes",
      ],
      { env, timeout: 60_000, maxBuffer: 1_000_000 },
    );
    server = spawn("pnpm", ["-C", workspace, "dev", "--port", "5189"], {
      cwd: web,
      env,
      detached: true,
      stdio: "ignore",
    });
    for (let attempt = 0; ; attempt++) {
      if (
        await nativeFetch(`${origin}/_agent-native/ping`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      assert(
        attempt < 50 && server.exitCode === null,
        "Local server did not start",
      );
      await delay(500);
    }
    stage = "authenticated landing";
    let signIn = await nativeFetch(`${origin}/sign-in`, {
      redirect: "manual",
      headers: { Accept: "text/html" },
    });
    for (let attempt = 0; signIn.status === 503 && attempt < 20; attempt++) {
      await delay(500);
      signIn = await nativeFetch(`${origin}/sign-in`, {
        redirect: "manual",
        headers: { Accept: "text/html" },
      });
    }
    remember(signIn);
    assert(
      cookies.size > 0,
      "Fresh development DB must issue its normal local session",
    );
    const inbox = await nativeFetch(`${origin}/inbox`, {
      headers: { cookie: [...cookies.values()].join("; ") },
    });
    assert(inbox.ok, "Authenticated inbox must load");
    dom = new Window({ url: `${origin}/requests/req_0001` });
    for (const [key, value] of Object.entries({
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
    })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", [...cookies.values()].join("; "));
      headers.set("origin", origin);
      headers.set("referer", `${origin}/requests/req_0001`);
      const response = await nativeFetch(new URL(String(input), origin), {
        ...init,
        headers,
      });
      remember(response);
      return response;
    };
    const { callAction, getBrowserTabId, writeClientAppState } =
      await import("@agent-native/core/client/hooks");
    await writeClientAppState(
      "navigation",
      { view: "request", requestId: "req_0001", path: "/requests/req_0001" },
      { requestSource: getBrowserTabId() },
    );
    stage = "start and overlap rejection";
    const first = await callAction<Demonstration>(
      "start-demonstration",
      { requestId: "req_0001" },
      { uiOnly: true },
    );
    let overlapRejected = false;
    try {
      await callAction(
        "start-demonstration",
        { requestId: "req_0001" },
        { uiOnly: true },
      );
    } catch {
      overlapRejected = true;
    }
    assert(overlapRejected, "Overlapping recording must fail");
    stage = "initial lookups, refund, reply, tag with automatic refetches";
    const request = await callAction<Request>(
      "get-request",
      { requestId: "req_0001" },
      { method: "GET" },
    );
    const order = await callAction<Order>(
      "get-order",
      { orderId: request.orderId! },
      { method: "GET" },
    );
    const refetch = () =>
      Promise.all([
        callAction("get-request", { requestId: request.id }, { method: "GET" }),
        callAction("get-order", { orderId: order.id }, { method: "GET" }),
        callAction(
          "get-shipment-status",
          { orderId: order.id },
          { method: "GET" },
        ),
        callAction(
          "get-customer",
          { customerId: request.customerId },
          { method: "GET" },
        ),
        callAction(
          "get-request-activity",
          { requestId: request.id },
          { method: "GET" },
        ),
      ]);
    await refetch();
    assert(
      request.content.source === "structured" &&
        request.content.fields.type === "damaged_item",
    );
    const productId = request.content.fields.productId;
    const platter = order.items.find((item) => item.productId === productId)!;
    const halfPriceMinor = Math.round(platter.unitPrice.amountMinor * 0.5);
    const refund = await callAction<Refund>(
      "issue-refund",
      {
        orderId: order.id,
        amount: { amountMinor: halfPriceMinor, currency: order.paid.currency },
        reason: fixtureText("issue-refund", "reason"),
      },
      { uiOnly: true },
    );
    assert.equal(refund.amount.amountMinor, halfPriceMinor);
    await refetch();
    await callAction(
      "send-reply",
      {
        requestId: request.id,
        template: fixtureText("send-reply", "template"),
        variables: {},
      },
      { uiOnly: true },
    );
    await refetch();
    await callAction(
      "tag-request",
      { requestId: request.id, tag: fixtureText("tag-request", "tag") },
      { uiOnly: true },
    );
    await refetch();
    await callAction(
      "get-request",
      { requestId: "req_0002" },
      { method: "GET" },
    );
    const otherTab = await callAction(
      "get-demonstration",
      { requestId: "req_0001" },
      {
        method: "GET",
        headers: { "X-Agent-Native-Browser-Tab": "smoke_other_tab" },
      },
    );
    assert.equal(otherTab, null);
    stage = "live readback";
    const live = await callAction<Demonstration>(
      "get-demonstration",
      { demonstrationId: first.id },
      { method: "GET" },
    );
    assert.equal(live.status, "recording");
    assert.equal(live.steps.length, 8);
    assert.deepEqual(
      live.steps.slice(5).map((s) => s.action),
      ["issue-refund", "send-reply", "tag-request"],
    );
    assert.equal(new Set(live.steps.slice(0, 5).map((s) => s.action)).size, 5);
    assert.equal(live.trigger.type, "damaged_item");
    assert.equal(live.trigger.requestId, "req_0001");
    assert(!("content" in live.trigger));
    assert.equal((live.steps[5]!.output as { id: string }).id, refund.id);
    stage = "stop and persisted readback";
    await callAction(
      "stop-demonstration",
      { demonstrationId: first.id },
      { uiOnly: true },
    );
    const savedTrace = await callAction<Demonstration>(
      "get-demonstration",
      { demonstrationId: first.id },
      { method: "GET" },
    );
    assert.equal(savedTrace.status, "completed");
    assert.equal(savedTrace.steps.length, 8);
    stage = "draft, persisted retrieval and dry-run on another damaged request";
    const draft = await callAction<RecipeDraft>(
      "draft-recipe-from-demonstration",
      { demonstrationId: first.id },
      { uiOnly: true },
    );
    assert.equal(draft.recipe.status, "draft");
    assert.equal(draft.recipe.activeVersionId, null);
    assert.deepEqual(
      draft.draft.steps.map((step) => step.id),
      ["step_2", "step_6", "step_7", "step_8"],
    );
    const retrieved = await callAction<RecipeDraft>(
      "get-recipe-draft",
      { versionId: draft.draft.id },
      { method: "GET" },
    );
    assert.deepEqual(retrieved, draft);
    const requests = await callAction<Request[]>(
      "list-requests",
      { type: "damaged_item", status: "open" },
      { method: "GET" },
    );
    const target = requests.find(
      (item) => item.id !== request.id && item.content.source === "structured",
    )!;
    assert(target && target.content.source === "structured");
    const targetOrder = await callAction<Order>(
      "get-order",
      { orderId: target.orderId! },
      { method: "GET" },
    );
    const before = await callAction(
      "get-request-activity",
      { requestId: target.id },
      { method: "GET" },
    );
    const dryRun = await callAction<Run>(
      "run-recipe",
      {
        recipe: retrieved.draft,
        trigger: buildRequestTrigger(
          target.content.fields as unknown as JsonObject,
          {
            requestId: target.id,
            customerId: target.customerId,
            subject: target.subject,
          },
        ),
        dryRun: true,
      },
      { uiOnly: true },
    );
    assert.equal(dryRun.status, "completed");
    assert.deepEqual(
      dryRun.steps.map((step) => step.status),
      ["completed", "planned", "planned", "planned"],
    );
    const reboundAmount = targetOrder.items[0]!.unitPrice.amountMinor * 0.5;
    assert.notEqual(reboundAmount, halfPriceMinor);
    assert.deepEqual(dryRun.steps[1]!.input, {
      orderId: target.orderId,
      amount: { amountMinor: reboundAmount, currency: "USD" },
      reason: "One platter arrived chipped - refund 50% of its price",
    });
    assert.deepEqual(dryRun.steps[2]!.input, {
      requestId: target.id,
      template: `Hi ${targetOrder.shippingAddress.name.split(/\s+/)[0]}, I am so sorry your Ember serving platter arrived chipped. We have refunded $${(reboundAmount / 100).toFixed(2)}, half of its price. Warmly, Kiln & Co.`,
      variables: {},
    });
    assert(
      draft.ambiguities.some((item) => item.kind === "request-specific-text"),
    );
    assert.deepEqual(dryRun.steps[3]!.input, {
      requestId: target.id,
      tag: "damaged",
    });
    assert.deepEqual(dryRun.tokens, { input: 0, output: 0 });
    assert.deepEqual(
      await callAction(
        "get-request-activity",
        { requestId: target.id },
        { method: "GET" },
      ),
      before,
    );
    stage = "Studio fixture list, stored platter draft and immutable edits";
    const readStudio = (recipeId: string) =>
      callAction<StudioDraft & { issues: unknown[] }>(
        "get-recipe-draft",
        { recipeId },
        { method: "GET" },
      );
    const recipes = await callAction<
      { id: string; runs: number; lastResult: string | null }[]
    >("list-recipes", {}, { method: "GET" });
    for (const id of [
      "recipe_fixture_damaged",
      "recipe_fixture_shipment",
      draft.recipe.id,
    ])
      assert(recipes.some((recipe) => recipe.id === id));
    for (const path of [
      "/recipes",
      "/recipes/recipe_fixture_damaged",
      `/recipes/${draft.recipe.id}`,
    ]) {
      const response = await globalThis.fetch(path, {
        headers: { Accept: "text/html" },
      });
      assert(response.ok, "Authenticated Studio route must load");
    }
    await writeClientAppState(
      "navigation",
      {
        view: "recipe",
        recipeId: draft.recipe.id,
        path: `/recipes/${draft.recipe.id}`,
      },
      { requestSource: getBrowserTabId() },
    );
    const storedPlatter = await readStudio(draft.recipe.id);
    assert.equal(storedPlatter.issues.length, 0);
    assert.deepEqual(storedPlatter.ambiguities, draft.ambiguities);
    for (const operator of ["find", "firstWord", "money", "cat"])
      assert(JSON.stringify(storedPlatter.content).includes(`"${operator}"`));
    const fixture = await readStudio("recipe_fixture_damaged");
    const edit = await callAction<StudioDraft>(
      "update-recipe-draft",
      {
        recipeId: fixture.recipeId,
        expectedRevision: fixture.revision,
        content: { ...fixture.content, name: "Studio fixture rehearsal" },
      },
      { uiOnly: true },
    );
    const version = await callAction<RecipeVersion>(
      "save-recipe-version",
      { recipeId: fixture.recipeId, expectedRevision: edit.revision },
      { uiOnly: true },
    );
    assert.equal(version.version, 2);
    await callAction(
      "activate-recipe",
      { recipeId: fixture.recipeId, versionId: version.id },
      { uiOnly: true },
    );
    const detail = await callAction<{
      recipe: { activeVersionId: string | null };
      history: { version: RecipeVersion; diff: unknown[] }[];
    }>("get-recipe", { recipeId: fixture.recipeId }, { method: "GET" });
    assert.equal(detail.recipe.activeVersionId, version.id);
    assert.equal(detail.history[0]!.version.version, 1);
    assert(detail.history[1]!.diff.length > 0);
    const current = await readStudio(fixture.recipeId);
    const invalid = await callAction<StudioDraft & { issues: unknown[] }>(
      "update-recipe-draft",
      {
        recipeId: fixture.recipeId,
        expectedRevision: current.revision,
        content: {
          ...current.content,
          trigger: { event: "request.created", match: { eval: ["invalid"] } },
        },
      },
      { uiOnly: true },
    );
    assert(invalid.issues.length > 0);
    await assert.rejects(() =>
      callAction(
        "save-recipe-version",
        { recipeId: fixture.recipeId, expectedRevision: invalid.revision },
        { uiOnly: true },
      ),
    );
    await callAction(
      "deactivate-recipe",
      { recipeId: fixture.recipeId },
      { uiOnly: true },
    );
    const original = await callAction<RecipeDraft>(
      "get-recipe-draft",
      { versionId: draft.draft.id },
      { method: "GET" },
    );
    assert.deepEqual(original, draft);
    await writeClientAppState(
      "navigation",
      {
        view: "request",
        requestId: request.id,
        path: `/requests/${request.id}`,
      },
      { requestSource: getBrowserTabId() },
    );
    stage = "cancel frees slot";
    const second = await callAction<Demonstration>(
      "start-demonstration",
      { requestId: "req_0001" },
      { uiOnly: true },
    );
    await callAction(
      "cancel-demonstration",
      { demonstrationId: second.id },
      { uiOnly: true },
    );
    const third = await callAction<Demonstration>(
      "start-demonstration",
      { requestId: "req_0001" },
      { uiOnly: true },
    );
    await callAction(
      "stop-demonstration",
      { demonstrationId: third.id },
      { uiOnly: true },
    );
    console.log(
      JSON.stringify({
        authenticatedLanding: true,
        studioFixtureRehearsal: true,
        storedBrokenPlatterInputsReplayed: true,
        canonicalDraftOpenedInStudio: true,
        immutableStudioVersionAndActivation: true,
        overlapRejected,
        sessionIsolation: true,
        unrelatedRequestExcluded: true,
        capturedActions: savedTrace.steps.slice(5).map((s) => s.action),
        distinctLookups: 5,
        refetchDeduplication: true,
        refundAmountMinor: halfPriceMinor,
        savedStepCount: savedTrace.steps.length,
        triggerShape: "intake",
        stopped: true,
        draftSavedAndRetrieved: true,
        draftStepCount: draft.draft.steps.length,
        dryRunRebound: true,
        dryRunAmountMinor: reboundAmount,
        dryRunTokens: dryRun.tokens,
        cancellationFreedSlot: true,
        demonstrationId: first.id,
      }),
    );
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom?.happyDOM.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
      if (server.exitCode === null)
        await Promise.race([
          new Promise((done) => server!.once("exit", done)),
          delay(3000),
        ]);
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes("--seed-recipes")) {
  assert(
    process.env.DATABASE_URL?.includes("muscle-memory-teach-smoke-"),
    "Fixture setup is limited to the isolated smoke database",
  );
  const { closeDbExec } = await import("@agent-native/core/db");
  const { getDb } = await import("../server/db/index.js");
  const { DrizzleRecipeCatalog } =
    await import("../server/infra/recipe-catalog.js");
  const { damagedItemFixture, whereIsMyOrderFixture } =
    await import("../server/fixtures/intake-recipes.js");
  const catalog = new DrizzleRecipeCatalog(getDb());
  for (const version of [damagedItemFixture, whereIsMyOrderFixture]) {
    await catalog.saveVersion(version);
    await catalog.save({
      id: version.recipeId,
      name: version.name,
      status: "draft",
      activeVersionId: null,
    });
  }
  await closeDbExec();
  process.exit(0);
}
try {
  await smoke();
} catch {
  console.error(
    `Teach HTTP smoke failed at: ${stage}. No credential or response details logged.`,
  );
  process.exitCode = 1;
}

// Client helpers retain session timers in Node; the server and DOM are closed above.
process.exit(process.exitCode ? 1 : 0);
