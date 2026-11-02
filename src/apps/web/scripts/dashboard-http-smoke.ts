// Opt-in HTTP smoke on a fresh temporary PGlite and local dev server.
// Hand-written recipes execute real structured intake. No LLM or usage fixtures.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HandlingStats } from "@muscle-memory/shop-domain";
import { Window } from "happy-dom";

if (process.argv[2] === "--prepare") {
  const { closeDbExec, withMigrationRuntime } =
    await import("@agent-native/core/db");
  const { loadActionsFromStaticRegistry } =
    await import("@agent-native/core/server");
  const { getDb } = await import("../server/db/index.js");
  const { default: migrateApp } = await import("../server/plugins/db.js");
  const { seedShop } = await import("../server/infra/shop-demo-store.js");
  const { createRequestIntake } = await import("../server/composition.js");
  const { RegistryActionInvoker } =
    await import("../server/infra/registry-action-invoker.js");
  const { damagedItemFixture, whereIsMyOrderFixture } =
    await import("../server/fixtures/intake-recipes.js");
  const { demoIntakeScript } = await import("../server/infra/demo-intake.js");
  const getOrder = await import("../actions/get-order.js");
  const issueRefund = await import("../actions/issue-refund.js");
  const sendReply = await import("../actions/send-reply.js");
  const tagRequest = await import("../actions/tag-request.js");
  await withMigrationRuntime(async () => {
    await migrateApp(undefined);
  });
  const db = getDb();
  await seedShop(db, { all: true });
  let sequence = 0;
  const cases = createRequestIntake(db, {
    registry: new RegistryActionInvoker(async () =>
      loadActionsFromStaticRegistry({
        "get-order": getOrder,
        "issue-refund": issueRefund,
        "send-reply": sendReply,
        "tag-request": tagRequest,
      }),
    ),
    ids: { next: () => `run_http${++sequence}` },
    extractor: {
      extract: async () => {
        throw new Error("Smoke uses structured requests only");
      },
    },
  });
  for (const recipe of [damagedItemFixture, whereIsMyOrderFixture]) {
    await cases.catalog.saveVersion(recipe);
    await cases.catalog.save({
      id: recipe.recipeId,
      name: recipe.name,
      status: "active",
      activeVersionId: recipe.id,
    });
  }
  for (const index of [0, 1, 3])
    await cases.intake.create(demoIntakeScript[index]!);
  await closeDbExec();
  process.exit(0);
}

const origin = process.argv[2];
assert(
  origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin),
  "Pass a local dev origin explicitly",
);
const web = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const directory = await mkdtemp(`${tmpdir()}/muscle-memory-dashboard-http-`);
const env = {
  ...process.env,
  DATABASE_URL: `pglite:${directory}/db`,
  NODE_ENV: "development",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: origin,
};
let server: ReturnType<typeof spawn> | undefined;
const cookies = new Map<string, string>();
const nativeFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
const dom = new Window({ url: `${origin}/dashboard` });
function remember(response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
}
let stage = "isolated preparation";
try {
  assert(
    !(await nativeFetch(`${origin}/_agent-native/ping`).then(
      () => true,
      () => false,
    )),
    "Smoke port must be free",
  );
  await promisify(execFile)(
    "pnpm",
    ["exec", "tsx", fileURLToPath(import.meta.url), "--prepare"],
    { cwd: web, env, timeout: 60_000, maxBuffer: 1_000_000 },
  );
  server = spawn("pnpm", ["dev", "--port", new URL(origin).port], {
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
      attempt < 100 && server.exitCode === null,
      "Local server did not start",
    );
    await delay(250);
  }
  stage = "local session";
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
  stage = `local session (HTTP ${signIn.status})`;
  remember(signIn);
  assert(cookies.size > 0, "Use the normal local development session");
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
    headers.set("referer", `${origin}/dashboard`);
    const response = await nativeFetch(new URL(String(input), origin), {
      ...init,
      headers,
    });
    remember(response);
    return response;
  };
  stage = "dashboard route";
  const page = await fetch(`${origin}/dashboard`);
  assert(
    page.ok && (await page.text()).includes("dashboard"),
    "Authenticated dashboard route loads",
  );
  stage = "shared action transport";
  const { callAction } = await import("@agent-native/core/client/hooks");
  const stats = await callAction<HandlingStats>(
    "get-handling-stats",
    {},
    { method: "GET" },
  );
  stage = "cohort validation";
  assert(stats.handled <= stats.limit);
  assert.equal(stats.handled, 2);
  assert.equal(stats.deterministic, 2);
  assert.equal(stats.pendingApprovals, 1);
  assert.equal(stats.activeRecipes, 2);
  assert.equal(stats.handled, stats.samples.length);
  assert.equal(stats.overall.recipe.tokenSamples, 2);
  assert.equal(stats.overall.recipe.meanTokens, 0);
  assert.equal(stats.overall.recipe.meanIntakeTokens, 0);
  assert.equal(stats.overall.recipe.meanRunTokens, 0);
  assert.equal(stats.overall.agent.meanTokens, null);
  assert(
    stats.samples.every(
      (s) =>
        s.intakeTokens === 0 && s.runTokens === 0 && s.agentTokens === null,
    ),
  );
  assert.equal(
    stats.deterministic,
    stats.samples.filter((s) => s.handler === "recipe" && s.tokens === 0)
      .length,
  );
  assert(
    stats.samples.every(
      (s) =>
        (s.tokens === null || s.tokens >= 0) &&
        (s.durationMs === null || s.durationMs >= 0),
    ),
  );
  stage = "repeat read";
  assert.deepEqual(
    await callAction("get-handling-stats", {}, { method: "GET" }),
    stats,
    "Read does not change or reprocess handling",
  );
  console.log(
    JSON.stringify({
      authenticatedDashboard: true,
      actionTransport: true,
      repeatReadUnchanged: true,
      handled: stats.handled,
      deterministic: stats.deterministic,
      pendingApprovals: stats.pendingApprovals,
      activeRecipes: stats.activeRecipes,
    }),
  );
} catch {
  console.error(
    `Dashboard HTTP smoke failed at ${stage}; no credentials or response details logged.`,
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of saved) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
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
// Client helpers keep session timers in Node.
process.exit(process.exitCode ? 1 : 0);
