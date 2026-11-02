// Opt-in live model verification on the requested dev port. Run with no server
// on 8080: NODE_ENV=development node --env-file=.env --import tsx scripts/chat-output-smoke.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentKitClient } from "@agent-native/agentkit";
import { closeDbExec } from "@agent-native/core/db";
import { addSession, COOKIE_NAME, createBetterAuthSessionForEmail } from "@agent-native/core/server";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import { orderMessageContent } from "@agent-native/toolkit/app/agentkit/react";
import type { Run } from "@muscle-memory/recipe-engine";
import type { Request as ShopRequest } from "@muscle-memory/shop-domain";
import { recipeCardOrder } from "../app/lib/chat-card-order.js";

const origin = "http://localhost:8080";
const web = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function smoke() {
  assert(process.env.AGENT_MODEL && process.env.AGENT_ENGINE, "Configured model required.");
  assert(!await fetch(`${origin}/_agent-native/ping`).then(() => true, () => false), "Port 8080 is occupied.");
  // Use Core's trusted action-bridge API for the existing local operator; no
  // credentials are read from SQL, printed or written to an evidence file.
  const session = await createBetterAuthSessionForEmail(process.env.AGENT_USER_EMAIL ?? "dev@local.test", undefined, { expiresAt: new Date(Date.now() + 30 * 60_000) });
  assert(session, "Existing local operator required; sign in once before this opt-in smoke.");
  await addSession(session.token, session.email);
  await closeDbExec();
  const cookies = new Map([[COOKIE_NAME, `${COOKIE_NAME}=${encodeURIComponent(session.token)}`]]);
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", [...cookies.values()].join("; "));
    headers.set("origin", origin);
    headers.set("referer", `${origin}/chat`);
    const response = await fetch(new URL(String(input), origin), { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
    return response;
  };
  async function json(path: string, body?: unknown) {
    const response = await authenticatedFetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert(response.ok, `HTTP verification failed at ${path.split("?")[0]} (${response.status}).`);
    return response.json();
  }
  async function action<T>(name: string, input: object, readOnly = false): Promise<T> {
    return readOnly
      ? json(`/_agent-native/actions/${name}?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]))}`)
      : json(`/_agent-native/actions/${name}`, input);
  }
  async function turn(message: string) {
    const thread = await json("/_agent-native/agent-chat/threads", {});
    const response = await authenticatedFetch("/_agent-native/agent-chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, threadId: thread.id }), signal: AbortSignal.timeout(240_000),
    });
    assert(response.ok, "Chat turn failed.");
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
      try { return [JSON.parse(line.slice(6))]; } catch { return []; }
    });
    assert(!events.some((event) => event.type === "error"), "Chat emitted an error.");
    let reply = "";
    for (const event of events) {
      if (event.type === "clear") reply = "";
      if (event.type === "text") reply += event.text ?? "";
    }
    const suggestionEvents = events.filter((event) => event.type === "suggestions");
    const suggestions = suggestionEvents[suggestionEvents.length - 1]?.suggestions ?? [];
    const title = (await json("/_agent-native/agent-chat/generate-title", { message, model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE })).title;
    assert(title, "Framework title generation did not return a title.");
    await json(`/_agent-native/agent-chat/threads/${thread.id}/rename`, { title });
    assert(reply && !/\p{Script=Han}/u.test(reply + title + JSON.stringify(suggestions)), "Non-English Han script in generated UI text.");
    return { threadId: thread.id as string, message, reply: reply.trim(), title: title as string, suggestions, events };
  }
  const child = spawn("pnpm", ["dev"], { cwd: web, detached: true, stdio: "ignore", env: { ...process.env, PORT: "8080" } });
  let transport: ReturnType<typeof createAgentNativeAgentKitTransport> | undefined;
  async function checkReload(threadId: string, title: string) {
    transport ??= createAgentNativeAgentKitTransport({ fetch: authenticatedFetch });
    const snapshot = await transport.getThreadSnapshot!({ threadId });
    assert(snapshot, "Reload snapshot unavailable.");
    const widgets = snapshot.widgets?.filter(({ widget }) => widget.kind === "muscle-memory.recipe-run") ?? [];
    assert.equal(widgets.length, 2, "Reload did not preserve both run cards.");
    const contentOrder = snapshot.messages.filter((message) => message.role === "assistant").flatMap((message) => {
      const embedded = new Set(message.parts.flatMap((part) => part.type === "widget" ? [part.widget.id] : []));
      const attached = widgets.filter((item) => item.messageId === message.id && !embedded.has(item.widget.id)).map((item) => item.widget);
      return orderMessageContent(message, message.parts, attached, [], recipeCardOrder).flatMap((item) => {
        if (item.type === "widget" || item.part.type === "widget") return ["run-card"];
        return item.part.type === "text" ? ["text"] : [];
      });
    });
    assert.deepEqual(contentOrder, ["run-card", "run-card", "text"], "Reload changed card/text placement.");
    const reloaded = await json(`/_agent-native/agent-chat/threads/${threadId}`);
    assert.equal(reloaded.title, title, "Reload changed the generated title.");
    return { runCardCount: widgets.length, title: reloaded.title, contentOrder, cardMessageIds: widgets.map((item) => item.messageId), messageParts: snapshot.messages.map((message) => ({ role: message.role, id: message.id, parts: message.parts.map((part) => part.type) })) };
  }
  try {
    for (let attempt = 0; ; attempt++) {
      if (await fetch(`${origin}/_agent-native/ping`).then((response) => response.ok, () => false)) break;
      assert(attempt < 60 && child.exitCode === null, "Dev server did not become ready.");
      await delay(1000);
    }
    if (process.argv.includes("--title-only")) {
      const result = await json("/_agent-native/agent-chat/generate-title", { message: "请查看批发客户对四十八只陶瓷碗的交期询问", model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE });
      assert(result.title && !/\p{Script=Han}/u.test(result.title), "Title is not English.");
      console.log({ title: result.title });
      return;
    }
    if (process.argv.includes("--reload-only")) {
      const evidence = JSON.parse(await readFile(new URL("./chat-output-evidence.json", import.meta.url), "utf8"));
      evidence.reload = await checkReload(evidence.runs.threadId, evidence.runs.title);
      await writeFile(new URL("./chat-output-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(evidence.reload);
      return;
    }
    if (process.argv.includes("--questions-only")) {
      const thread = await json("/_agent-native/agent-chat/threads", {});
      const makeTransport = () => createAgentNativeAgentKitTransport({ fetch: authenticatedFetch, browserTabId: "task28_question_smoke", model: process.env.AGENT_MODEL!, engine: process.env.AGENT_ENGINE!, adapter: { textFormat: "markdown" } });
      transport = makeTransport();
      let client = new AgentKitClient({ transport });
      const assistantText = () => client.getThread(thread.id).messages.filter((message) => message.role === "assistant").slice(-1)[0]?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim() ?? "";
      const prompt = "Help me decide a refund recipe policy: should every refund require human approval or only refunds above $100? Use the question widget to ask me once, with options 'Every refund' and 'Only above $100'. Wait for my answer, then explain the chosen policy in one sentence. Do not change any recipes or shop data.";
      try {
        await client.loadThread(thread.id);
        const asking = await client.sendMessage({ threadId: thread.id, text: prompt });
        await asking.completed;
        const questionTool = Object.values(client.getThread(thread.id).tools).find((tool) => tool.name === "ask-question" && tool.status === "completed");
        assert(questionTool, "Agent did not ask through the question widget.");
        const question = questionTool.input as { question: string; options: string | { label: string }[] };
        const options: { label: string }[] = typeof question.options === "string" ? JSON.parse(question.options) : question.options;
        const beforeReload = assistantText();
        console.log(JSON.stringify({ kind: "pending-question", threadId: thread.id, question: question.question, options: options.map((option) => option.label), reply: beforeReload }, null, 2));
        const questionSentence = beforeReload.split("?")[0] ?? "";
        assert(beforeReload.includes("?") && /refund/iu.test(questionSentence) && /approv/iu.test(questionSentence) && questionSentence.includes("$100"), "Assistant text does not state the refund policy question.");
        assert(options.every((option) => beforeReload.includes(option.label)), "Assistant text omits question options.");
        await client.dispose();
        await transport.dispose();
        transport = makeTransport();
        client = new AgentKitClient({ transport });
        await client.loadThread(thread.id);
        const afterReload = assistantText();
        assert.equal(afterReload, beforeReload, "Reload lost the readable question/options.");
        const typedAnswer = "Every refund.";
        const answering = await client.sendMessage({ threadId: thread.id, text: typedAnswer });
        assert("runId" in answering, "Plain-text answer was queued instead of starting a run.");
        const answerRunId = answering.runId;
        await answering.completed;
        const continuation = assistantText();
        assert(!Object.values(client.getThread(thread.id).tools).some((tool) => tool.name === "ask-question" && tool.runId === answerRunId), "Agent asked the settled question again.");
        assert(/every refund/iu.test(continuation) && /approv/iu.test(continuation), "Agent did not continue with the typed policy choice.");
        const evidence = { model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE, origin, threadId: thread.id, prompt, question: question.question, options: options.map((option) => option.label), beforeReload, afterReload, typedAnswer, continuation, limitation: "Browser access host unavailable; native Chrome access rejected by computer-use approval. Verified using the same AgentKit client/transport as the UI, with a new client and transport loading the saved thread before the typed answer." };
        await writeFile(new URL("./chat-question-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(JSON.stringify(evidence, null, 2));
      } finally {
        await client.dispose();
      }
      return;
    }
    const source = await action<ShopRequest>("get-request", { requestId: "req_0005" }, true);
    assert(source.content.source === "structured", "Seeded wholesale request required.");
    const request = await action<ShopRequest>("create-request", { customerId: source.customerId, subject: source.subject, content: source.content });
    const wholesale = await turn(`Review the wholesale handoff for ${request.id}. Read its request and processing context, then explain what the operator needs to decide before replying. Do not change the request or send a reply yet.`);
    assert(wholesale.suggestions.length > 0, "Wholesale turn did not offer any suggested actions.");
    console.log(JSON.stringify({ kind: "wholesale", threadId: wholesale.threadId, title: wholesale.title, reply: wholesale.reply, suggestions: wholesale.suggestions.map((item: { label: string; prompt: string }) => ({ label: item.label, prompt: item.prompt })) }, null, 2));
    const stamp = Date.now().toString(36);
    const recipe = (suffix: string, approval: boolean) => ({
      id: `ver_chat28_${stamp}_${suffix}`, recipeId: `rcp_chat28_${stamp}_${suffix}`, version: 1,
      name: approval ? "Wholesale review approval" : "Wholesale request lookup",
      trigger: { event: "request.created", match: true },
      steps: [{ id: "request", kind: "action", action: "get-request", args: { requestId: { mode: "path", path: "trigger.requestId" } }, ...(approval ? { approval: true } : {}) }],
    });
    const completed = await action<Run>("run-recipe", { recipe: recipe("read", false), trigger: { requestId: request.id }, dryRun: false });
    const paused = await action<Run>("run-recipe", { recipe: recipe("gate", true), trigger: { requestId: request.id }, dryRun: false });
    assert.equal(completed.status, "completed");
    assert.equal(paused.status, "awaiting_approval");
    const runs = await turn(`Inspect these two saved runs with get-recipe-run: ${completed.id} and ${paused.id}. What is their status and next step? Do not approve or change either run.`);
    console.log(JSON.stringify({ kind: "run-reply", threadId: runs.threadId, title: runs.title, reply: runs.reply }, null, 2));
    assert.equal(runs.events.filter((event) => event.type === "tool_done" && event.tool === "get-recipe-run" && !event.isError).length, 2, "Agent did not inspect both saved runs.");
    assert(!/\||run_[A-Za-z0-9_-]+|req_\d+|ver_[A-Za-z0-9_-]+/u.test(runs.reply), "Reply repeats a table or raw IDs.");
    assert(runs.reply.length < 500, "Card reply is too long.");
    const liveContentOrder = runs.events.flatMap((event) => event.type === "tool_done" && event.tool === "get-recipe-run" && !event.isError ? ["run-card"] : event.type === "text" && event.text ? ["text"] : []).filter((item, index, items) => item !== "text" || items[index - 1] !== "text");
    assert.deepEqual(liveContentOrder, ["run-card", "run-card", "text"], "Live cards do not precede closing text.");
    const reload = await checkReload(runs.threadId, runs.title);
    const metadata = (turn: typeof runs) => ({ threadId: turn.threadId, message: turn.message, title: turn.title, reply: turn.reply, suggestions: turn.suggestions, toolNames: turn.events.filter((event) => event.type === "tool_done" && !event.isError).map((event) => event.tool) });
    const evidence = { model: process.env.AGENT_MODEL, engine: process.env.AGENT_ENGINE, origin, wholesale: metadata(wholesale), runs: metadata(runs), liveContentOrder, reload, limitation: "Browser automation host unavailable. Live model, stream order and reloaded snapshot checked over authenticated HTTP with the public Toolkit ordering helper; mounted Toolkit rendering/order checked by offline regressions." };
    await writeFile(new URL("./chat-output-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ kind: "runs", ...metadata(runs), reload: evidence.reload }, null, 2));
  } finally {
    await transport?.dispose();
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
      await Promise.race([new Promise((done) => child.once("exit", done)), delay(5000)]);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
  }
}

smoke().then(() => process.exit(0), (error) => {
  // Never serialize subprocess/provider errors, credentials, or cookie values.
  console.error(error instanceof assert.AssertionError ? error.message : "Chat output smoke failed; sensitive details suppressed.");
  process.exit(1);
});
