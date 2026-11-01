// Opt-in live verification. Normal tests never call a model or start a server.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { Window } from "happy-dom";
import type { RefundId } from "@muscle-memory/shop-domain";
import { eq } from "drizzle-orm";
import { createShopDemoData } from "../server/db/shop-demo-data.js";

const exec = promisify(execFile);
const web = fileURLToPath(new URL("../", import.meta.url));
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function stopServer(child: ReturnType<typeof spawn> | undefined) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
  if (child.exitCode === null) await Promise.race([new Promise((done) => child.once("exit", done)), delay(5_000)]);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
}

export async function runShopActionsSmoke() {
  assert(process.env.AGENT_MODEL && process.env.AGENT_ENGINE, "Configured model environment required.");
  const origin = "http://localhost:8097";
  assert(!await fetch(`${origin}/_agent-native/ping`).then(() => true, () => false), "Smoke port 8097 is occupied.");
  const directory = await mkdtemp(resolve(tmpdir(), "muscle-memory-task7-"));
  const env = {
    ...process.env, DATABASE_URL: `pglite:${directory}/db`, NODE_ENV: "development",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_URL: origin,
  };
  const cookies = new Map<string, string>();
  const rememberCookies = (response: Response) => {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  };
  const cookieHeader = () => [...cookies.values()].join("; ");
  let child: ReturnType<typeof spawn> | undefined;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    // Uses the requested public seed command before any process owns PGlite.
    await exec("pnpm", ["-C", workspace, "seed:shop"], { env, timeout: 60_000, maxBuffer: 1_000_000 });
    child = spawn("pnpm", ["dev", "--port", "8097"], { cwd: web, detached: true, stdio: "ignore", env });
    for (let attempt = 0; ; attempt++) {
      if (await fetch(`${origin}/_agent-native/ping`).then((response) => response.ok, () => false)) break;
      assert(attempt < 60 && child.exitCode === null, "Local smoke server did not become ready.");
      await delay(1_000);
    }
    let signIn = await fetch(`${origin}/sign-in`, { headers: { Accept: "text/html" }, redirect: "manual" });
    for (let attempt = 0; signIn.status === 503 && attempt < 20; attempt++) {
      await delay(500);
      signIn = await fetch(`${origin}/sign-in`, { headers: { Accept: "text/html" }, redirect: "manual" });
    }
    rememberCookies(signIn);
    assert(cookies.size, "Fresh local database did not issue a development session.");
    console.log("Seeded isolated PGlite and authenticated local app ready.");

    const fixtures = createShopDemoData();
    const requestId = "req_0002";
    const request = fixtures.requests.find((item) => item.id === requestId)!;
    const order = fixtures.orders.find((item) => item.id === request.orderId)!;
    const shipment = fixtures.shipments.find((item) => item.orderId === order.id)!;
    const nativeFetch = globalThis.fetch;
    const dom = new Window({ url: `${origin}/home` });
    const saved = new Map<string, PropertyDescriptor | undefined>();
    let parity: object;
    let frontendRefundId: RefundId;
    for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    // Only the browser network boundary supplies its cookie jar and origin.
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", cookieHeader());
      headers.set("origin", origin);
      headers.set("referer", `${origin}/home`);
      const response = await nativeFetch(new URL(String(input), origin), { ...init, headers });
      rememberCookies(response);
      return response;
    };
    try {
      const { callAction } = await import("@agent-native/core/client/hooks");
      const uiShipment = await callAction("get-shipment-status", { orderId: order.id }, { method: "GET" });
      assert.deepEqual(uiShipment, { orderStatus: order.status, shipment });
      const cli = await exec("pnpm", ["action", "get-shipment-status", "--orderId", order.id], { cwd: web, env, timeout: 30_000, maxBuffer: 1_000_000 });
      assert.equal(cli.stdout.trim(), inspect(uiShipment), "CLI and frontend shipment outputs differ.");
      const mutation = await exec("pnpm", ["action", "tag-request", "--requestId", "req_0001", "--tag", "cli-proof"], { cwd: web, env, timeout: 30_000, maxBuffer: 1_000_000 });
      const uiRequest = await callAction("get-request", { requestId: "req_0001" }, { method: "GET" });
      assert(uiRequest.tags.includes("cli-proof"), "CLI mutation was not visible through frontend actions.");
      assert.equal(mutation.stdout.trim(), inspect(uiRequest), "CLI write result differs from frontend readback.");
      // A real UI capability proves that the >$100 agent gate does not block the UI.
      const refund = await callAction("issue-refund", { orderId: "ord_1001", amount: { amountMinor: 10001, currency: "USD" }, reason: "Synthetic UI approval-gate verification" }, { uiOnly: true });
      frontendRefundId = refund.id;
      assert.equal(refund.amount.amountMinor, 10001);
      parity = { read: "get-shipment-status", write: "tag-request", samePrintedResult: true, writeVisibleInFrontend: true, transport: "callAction client helper over authenticated HTTP + pnpm action", frontendRefundAboveLimit: true };
    } finally {
      globalThis.fetch = nativeFetch;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await dom.happyDOM.close();
    }
    console.log("CLI/frontend read and mutation parity passed; frontend refund above $100 passed.");

    const started = performance.now();
    const response = await fetch(`${origin}/_agent-native/agent-chat`, {
      method: "POST", headers: { cookie: cookieHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Handle the where-is-my-order customer request ${requestId} end to end. Look up the actual shipment, save a helpful accurate reply to the customer and resolve the request. Use only shop actions to do the work.`,
        model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE,
      }),
      signal: AbortSignal.timeout(240_000),
    });
    assert(response.ok, "Local chat request failed.");
    // Raw model/provider output stays in memory and is never logged or saved.
    const stream = await response.text();
    const events = stream.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
      try { return [JSON.parse(line.slice(6))]; } catch { return []; }
    });
    assert(!events.some((event) => event.type === "error"), "Local chat emitted an error.");
    const completed = events.filter((event) => event.type === "tool_done");
    const names: string[] = completed.map((event) => event.tool);
    const shopActions = ["list-requests", "get-request", "get-order", "get-customer", "get-shipment-status", "issue-refund", "send-reply", "tag-request", "set-request-status", "escalate", "create-replacement-order", "update-shipping-address", "generate-return-label"];
    assert(names.every((name) => shopActions.includes(name)), "Agent used a non-shop tool.");
    for (const name of ["get-request", "get-shipment-status", "send-reply", "set-request-status"]) {
      assert(completed.some((event) => event.tool === name && !event.isError), `Agent did not complete ${name}.`);
    }
    const elapsedMs = Math.round(performance.now() - started);
    await stopServer(child);
    child = undefined;

    // Observe persisted effects directly after releasing the server's PGlite lock.
    process.env.DATABASE_URL = env.DATABASE_URL;
    const { closeDbExec } = await import("@agent-native/core/db");
    closeDb = closeDbExec;
    const { getDb } = await import("../server/db/index.js");
    const tables = await import("../server/db/schema.js");
    const db = getDb();
    const [storedRequest] = await db.select().from(tables.requests).where(eq(tables.requests.id, requestId));
    const storedReplies = await db.select().from(tables.replies).where(eq(tables.replies.requestId, requestId));
    assert.equal(storedRequest?.status, "resolved", "Agent did not persist resolved status.");
    assert.equal(storedReplies.length, 1, "Expected exactly one stored reply.");
    const storedReply = storedReplies[0]!;
    assert.equal(storedReply.to, fixtures.customers.find((item) => item.id === request.customerId)!.email);
    assert(storedReply.body.includes(shipment.carrier), "Reply omitted the actual carrier.");
    assert(storedReply.body.includes(shipment.trackingNumber!), "Reply omitted the actual tracking number.");
    assert(/transit|on (?:its|the) way|shipped/i.test(storedReply.body), "Reply omitted shipment status.");
    const [storedRefund] = await db.select().from(tables.refunds).where(eq(tables.refunds.id, frontendRefundId));
    assert.equal(storedRefund?.amount.amountMinor, 10001);
    const evidence = {
      executedAt: new Date().toISOString(), model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE,
      seedCommand: "pnpm -C src seed:shop", database: "isolated temporary PGlite with deterministic demo seed",
      chat: { endpoint: "/_agent-native/agent-chat", requestId, orderId: order.id, completedTools: names, elapsedMs, onlyShopTools: true },
      persisted: { requestStatus: storedRequest.status, replyCount: storedReplies.length, recipientMatched: true, carrierMatched: true, trackingMatched: true, shipmentStatusIncluded: true, frontendRefundAmountMinor: storedRefund.amount.amountMinor },
      parity,
      limitation: "Frontend transport is exercised with the real client helper in Happy DOM; the request workspace UI belongs to TASK-8.",
    };
    await writeFile(new URL("./shop-actions-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Real ${process.env.AGENT_MODEL} chat resolved ${requestId} using ${names.join(", ")}; persisted effects verified. Sanitized evidence saved.`);
  } finally {
    await stopServer(child);
    await closeDb?.();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runShopActionsSmoke().then(() => process.exit(0), (error) => {
    // Never serialize subprocess errors, provider responses, environment or cookies.
    console.error(error instanceof assert.AssertionError ? error.message : "Shop action smoke failed; provider/subprocess details suppressed.");
    process.exit(1);
  });
}
