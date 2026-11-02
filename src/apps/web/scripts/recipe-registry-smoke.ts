// apps/web: NODE_ENV=development node --env-file=.env --import tsx scripts/recipe-registry-smoke.ts [--live-agent] [--claude] [--hold]
// Disposable PGlite, documented loopback local-dev auth, port 8095 only.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RecipeVersion, Run } from "@muscle-memory/recipe-engine";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";

const web = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const origin = "http://localhost:8095";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const version: RecipeVersion = {
  id: "ver_registry_smoke1", recipeId: "recipe_registry_smoke", version: 1, name: "Delivery request review",
  trigger: { event: "request.created", match: { "==": [{ var: "trigger.type" }, "where_is_my_order"] } },
  steps: [
    { id: "request", kind: "action", action: "get-request", args: { requestId: { mode: "path", path: "trigger.requestId" } } },
    { id: "tag", kind: "action", action: "tag-request", args: { requestId: { mode: "path", path: "trigger.requestId" }, tag: { mode: "fixed", value: "registry-reviewed" } } },
  ],
};
async function seedFixture() {
  const { closeDbExec, withMigrationRuntime } = await import("@agent-native/core/db");
  const { getDb } = await import("../server/db/index.js");
  const { default: migrateApp } = await import("../server/plugins/db.js");
  const { DrizzleRecipeCatalog } = await import("../server/infra/recipe-catalog.js");
  try {
    await withMigrationRuntime(async () => { await migrateApp(undefined); });
    const catalog = new DrizzleRecipeCatalog(getDb());
    await catalog.saveVersion(version);
    await catalog.saveVersion({ ...version, id: "ver_registry_smoke2", version: 2, name: "Updated delivery request review" });
    await catalog.save({ id: version.recipeId, name: version.name, status: "draft", activeVersionId: null });
  } finally { await closeDbExec(); }
}
let stage = "setup";
async function smoke() {
  const reuse = process.argv.includes("--reuse");
  if (reuse) assert(process.env.DATABASE_URL?.includes("/muscle-memory-registry-smoke-"), "--reuse requires the disposable registry smoke DATABASE_URL");
  else assert(!await fetch(`${origin}/_agent-native/ping`).then(() => true, () => false), "Port 8095 must be free.");
  const directory = reuse ? null : await mkdtemp(`${tmpdir()}/muscle-memory-registry-smoke-`);
  const env = { ...process.env, DATABASE_URL: reuse ? process.env.DATABASE_URL! : `pglite:${directory}/db`, NODE_ENV: "development", PORT: "8095", BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), AGENT_NATIVE_OWNER_EMAIL: "dev@local.test" };
  const cookies = new Map<string, string>();
  const nativeFetch = globalThis.fetch;
  let child: ReturnType<typeof spawn> | undefined;
  let transport: ReturnType<typeof createAgentNativeAgentKitTransport> | undefined;
  const evidence: Record<string, unknown> = { origin, auth: "Framework loopback local-dev; no bearer credentials; server-configured owner dev@local.test", jsonrpc: [] };
  function remember(response: Response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  }
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", [...cookies.values()].join("; "));
    headers.set("origin", origin);
    headers.set("referer", `${origin}/chat`);
    const response = await nativeFetch(new URL(String(input), origin), { ...init, headers });
    remember(response);
    return response;
  };
  async function json(path: string, body?: unknown) {
    const response = await authenticatedFetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert(response.ok, `HTTP ${response.status} at ${path.split("?")[0]}`);
    return response.json();
  }
  async function action(name: string, args: object, read = false) {
    return read ? json(`/_agent-native/actions/${name}?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]))}`) : json(`/_agent-native/actions/${name}`, args);
  }
  let sessionId: string | null = null;
  let id = 0;
  async function rpc(method: string, params?: object, notification = false): Promise<any> {
    const call = { jsonrpc: "2.0", ...(!notification ? { id: ++id } : {}), method, ...(params ? { params } : {}) };
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", "x-agent-native-owner-email": "dev@local.test" });
    if (sessionId) headers.set("mcp-session-id", sessionId);
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(call) });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    assert(response.ok, `MCP ${method} HTTP ${response.status}`);
    const raw = await response.text();
    const result = raw.startsWith("event:") || raw.startsWith("data:")
      ? raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(event => event.id === call.id)
      : raw ? JSON.parse(raw) : null;
    assert(!result?.error && !result?.result?.isError, `MCP ${method} returned an error`);
    (evidence.jsonrpc as unknown[]).push({ call, httpStatus: response.status });
    return result?.result;
  }
  function toolJson(result: any): any {
    if (result.structuredContent) return result.structuredContent;
    const item = result.content?.find((item: any) => item.type === "text" && /^[{[]/.test(item.text.trim()));
    assert(item, "MCP tool omitted structured content");
    return JSON.parse(item.text);
  }
  try {
    if (!reuse) {
      await exec("pnpm", ["seed:shop"], { cwd: web, env, timeout: 60_000, maxBuffer: 1_000_000 });
      await exec("pnpm", ["exec", "tsx", "scripts/recipe-registry-smoke.ts", "--seed-fixture"], { cwd: web, env, timeout: 60_000, maxBuffer: 1_000_000 });
      child = spawn("pnpm", ["dev", "--port", "8095"], { cwd: web, env, detached: true, stdio: "ignore" });
    }
    for (let attempt = 0; ; attempt++) {
      if (await fetch(`${origin}/_agent-native/ping`).then(response => response.ok, () => false)) break;
      assert(attempt < 60 && (!child || child.exitCode === null), "Dev server did not start");
      await delay(1000);
    }
    stage = "normal local-dev sign-in";
    let signIn = await fetch(`${origin}/sign-in`, { redirect: "manual", headers: { accept: "text/html" } });
    for (let attempt = 0; signIn.status === 503 && attempt < 20; attempt++) {
      await delay(500);
      signIn = await fetch(`${origin}/sign-in`, { redirect: "manual", headers: { accept: "text/html" } });
    }
    remember(signIn);
    if (!cookies.size) {
      // Same handler as the framework's Continue as local dev button.
      const session = await authenticatedFetch("/_agent-native/auth/local-dev", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert(session.ok, "Continue as local dev failed");
    }
    assert(cookies.size, "Local-dev sign-in did not issue a session");
    assert((await authenticatedFetch("/inbox")).ok, "Authenticated landing failed");
    stage = "Studio activation";
    const active = await action("activate-recipe", { recipeId: version.recipeId, versionId: version.id });
    assert(active?.skillPublication, `Activation omitted publication receipt (keys: ${Object.keys(active ?? {}).join(", ")})`);
    assert.equal(active.skillPublication.status, "published");
    const request = reuse
      ? (await action("list-requests", { type: "where_is_my_order" }, true)).find((request: any) => request.content.source === "structured" && !request.tags.includes("registry-reviewed"))
      : await action("get-request", { requestId: "req_0002" }, true);
    assert(request?.content?.source === "structured", "An unused structured delivery request is required");
    assert.equal(request.content.fields.type, "where_is_my_order");
    const trigger = { requestId: request.id, ...request.content.fields };
    stage = "MCP handshake and discovery";
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "muscle-memory-registry-smoke", version: "1.0" } });
    await rpc("notifications/initialized", undefined, true);
    const tools = await rpc("tools/list", {});
    for (const name of ["list-recipes", "run-recipe"]) assert(tools.tools.some((tool: any) => tool.name === name), `MCP did not expose ${name}`);
    const listed = toolJson(await rpc("tools/call", { name: "list-recipes", arguments: { status: "active" } }));
    const rows = Array.isArray(listed) ? listed : listed.items;
    assert(rows?.some((row: any) => row.activeVersion?.id === version.id), `MCP omitted active version (response keys: ${Object.keys(listed).join(", ")})`);
    const dryInput = { recipe: version, trigger, dryRun: true };
    stage = "MCP dry-run";
    const result = toolJson(await rpc("tools/call", { name: "run-recipe", arguments: dryInput }));
    const run = (result.run ?? result) as Run;
    assert.equal(run.mode, "dry-run");
    assert.equal(run.status, "completed");
    assert.deepEqual(run.tokens, { input: 0, output: 0 });
    assert.deepEqual((await action("get-request", { requestId: request.id }, true)).tags, request.tags);
    evidence.mcp = { runId: run.id, status: run.status, mode: run.mode, shopUnchanged: true };
    stage = "CLI parity";
    const cliList = await exec("pnpm", ["action", "list-recipes", JSON.stringify({ status: "active" })], { cwd: web, env, timeout: 30_000, maxBuffer: 1_000_000 });
    assert(cliList.stdout.includes(version.name) && cliList.stdout.includes(version.id), "CLI omitted active recipe");
    const cliRun = await exec("pnpm", ["action", "run-recipe", JSON.stringify(dryInput)], { cwd: web, env, timeout: 30_000, maxBuffer: 1_000_000 });
    assert(cliRun.stdout.includes("dry-run") && cliRun.stdout.includes("completed"), "CLI dry-run failed");
    assert.deepEqual((await action("get-request", { requestId: request.id }, true)).tags, request.tags);
    evidence.cli = { list: "pnpm action list-recipes '{\"status\":\"active\"}'", run: `pnpm action run-recipe '${JSON.stringify(dryInput)}'`, dryRunCompleted: true, shopUnchanged: true };
    if (process.argv.includes("--live-agent")) {
      stage = "live agent discovery and execution";
      assert(process.env.AGENT_MODEL && process.env.AGENT_ENGINE, "Configured chat model required");
      const thread = await json("/_agent-native/agent-chat/threads", {});
      async function turn(message: string) {
        const response = await authenticatedFetch("/_agent-native/agent-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, threadId: thread.id }), signal: AbortSignal.timeout(240_000) });
        assert(response.ok, "Live chat HTTP failed");
        const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } });
        assert(!events.some(event => event.type === "error"), "Live chat error");
        let reply = "";
        for (const event of events) { if (event.type === "clear") reply = ""; if (event.type === "text") reply += event.text ?? ""; }
        return { reply: reply.trim(), events };
      }
      const discovery = await turn("What recipes can you run? Describe the active runtime recipe skills available to you.");
      assert(discovery.reply.includes(version.name), "Agent did not discover published recipe");
      const execution = await turn(`Run the ${version.name} recipe on request ${request.id}. Follow its runtime skill: dry-run first, then execute if suitable. I authorize the tag operation in this isolated smoke database. Do not activate or edit recipes. Keep the reply to one or two short sentences using the recipe name and cards; omit all raw IDs and step details.`);
      assert(execution.events.filter(event => event.type === "tool_done" && event.tool === "run-recipe" && !event.isError).length >= 2, "Agent did not dry-run and execute");
      assert((await action("get-request", { requestId: request.id }, true)).tags.includes("registry-reviewed"), "Agent tag not persisted");
      assert(execution.reply.length < 500 && !/(?:run_|req_|ver_)[A-Za-z0-9_-]+|\|/.test(execution.reply), "Card reply repeats details or IDs");
      transport = createAgentNativeAgentKitTransport({ fetch: authenticatedFetch });
      const snapshot = await transport.getThreadSnapshot!({ threadId: thread.id });
      const runModes = snapshot?.toolCalls?.filter(tool => tool.name === "run-recipe").map(tool => (tool.output as Run).mode);
      assert.deepEqual(runModes, ["dry-run", "execute"], "Agent did not dry-run before execution");
      const widgets = snapshot?.widgets?.filter(({ widget }) => widget.kind === "muscle-memory.recipe-run") ?? [];
      assert(widgets.length >= 2, "Reload did not preserve run cards");
      const { verifyRegistryCards } = await import("./recipe-registry-cards.js");
      const renderedCards = await verifyRegistryCards(transport, authenticatedFetch, thread.id);
      evidence.agent = { model: process.env.AGENT_MODEL, threadId: thread.id, discovery: discovery.reply, reply: execution.reply, toolNames: execution.events.filter(event => event.type === "tool_done" && !event.isError).map(event => event.tool), runModes, runCardCount: widgets.length, renderedCards, persistedTag: true };
    }
    if (process.argv.includes("--claude")) {
      stage = "Claude Code MCP verification";
      const config = JSON.stringify({ mcpServers: { muscle_memory: { type: "http", url: `${origin}/mcp`, headers: { "X-Agent-Native-Owner-Email": "dev@local.test" } } } });
      const prompt = `Use only muscle_memory MCP. Call list-recipes with status active, then run-recipe with this exact JSON: ${JSON.stringify(dryInput)}. Do not execute mutations or ask-agent. Report only recipe name, dry-run mode and final status.`;
      const response = await exec("claude", ["--print", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", config, "--allowedTools", "mcp__muscle_memory__list-recipes,mcp__muscle_memory__run-recipe", "--", prompt], { cwd: web, env, timeout: 180_000, maxBuffer: 2_000_000 });
      const events = response.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
      const toolNames = events.flatMap(event => event.type === "assistant" ? event.message?.content?.filter((part: any) => part.type === "tool_use").map((part: any) => part.name) ?? [] : []);
      const reply = events.find(event => event.type === "result")?.result ?? "";
      assert(reply.includes(version.name) && /completed|dry.run/i.test(reply), "Claude Code verification failed");
      assert(toolNames.includes("mcp__muscle_memory__list-recipes") && toolNames.includes("mcp__muscle_memory__run-recipe"), "Claude Code did not call both recipe MCP tools");
      evidence.claude = { verified: true, toolNames, reply };
    }
    stage = "update and removal";
    const updated = await action("activate-recipe", { recipeId: version.recipeId, versionId: "ver_registry_smoke2" });
    assert.equal(updated.skillPublication.versionId, "ver_registry_smoke2");
    assert.equal(updated.skillPublication.status, "published");
    assert.equal((await action("deactivate-recipe", { recipeId: version.recipeId })).skillPublication.status, "removed");
    assert.equal((await action("list-recipes", { status: "active" }, true)).length, 0);
    evidence.lifecycle = { published: true, updated: true, removed: true, sameServerProcess: true };
    await writeFile(new URL("./recipe-registry-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
    if (process.argv.includes("--hold")) {
      await action("activate-recipe", { recipeId: version.recipeId, versionId: version.id });
      console.log("Browser review available on port 8095 for five minutes.");
      for (let i = 0; i < 300; i++) await delay(1000);
    }
  } finally {
    await transport?.dispose();
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
      await Promise.race([new Promise(resolve => child!.once("exit", resolve)), delay(5000)]);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
const work = process.argv.includes("--seed-fixture") ? seedFixture() : smoke();
work.then(() => process.exit(0), error => {
  console.error(`Registry smoke failed during ${stage}: ${error instanceof assert.AssertionError ? error.message : `details suppressed (${error instanceof Error ? error.name : "unknown error"}) to protect credentials`}`);
  if (error instanceof Error) console.error(error.stack?.split("\n").slice(1).filter(line => line.includes("recipe-registry-smoke.ts")).join("\n"));
  process.exit(1);
});
