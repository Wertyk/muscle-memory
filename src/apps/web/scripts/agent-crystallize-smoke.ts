/** Opt-in TASK-19 live-model rehearsal on 8097. Reseed first. Synthetic evidence and effects remain for review. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";

import { AgentKitClient } from "@agent-native/agentkit";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import {
  buildRequestTrigger,
  type Demonstration,
  type JsonObject,
  type RecipeDraft,
  type RecipeVersion,
  type Run,
} from "@muscle-memory/recipe-engine";
import type {
  Customer,
  Order,
  Request,
} from "@muscle-memory/shop-domain";
import { Window } from "happy-dom";

import { shopMessages } from "../app/i18n/shop-en.js";
import { recipeMessages } from "../app/i18n/recipes-en.js";

const origin = "http://localhost:8097";
const nativeFetch = globalThis.fetch;
let response = await nativeFetch(`${origin}/sign-in`, {
  redirect: "manual",
  headers: { Accept: "text/html" },
});
if (!response.headers.getSetCookie().length)
  response = await nativeFetch(`${origin}/_agent-native/auth/local-dev`, {
    method: "POST",
    headers: { origin },
  });
const cookies = new Map<string, string>();
const remember = (response: Response) => {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
};
remember(response);
assert(cookies.size, "Local development session required");
const dom = new Window({ url: `${origin}/recipes` });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}
globalThis.fetch = async (input, init) => {
  const result = await nativeFetch(new URL(String(input), origin), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      cookie: [...cookies.values()].join("; "),
      origin,
      referer: `${origin}/recipes`,
    },
  });
  remember(result);
  return result;
};
const { callAction, writeClientAppState, getBrowserTabId } =
  await import("@agent-native/core/client/hooks");
const action = <T>(
  name: string,
  input: Record<string, unknown> = {},
  read = true,
) => callAction<T>(name, input, read ? { method: "GET" } : { uiOnly: true });
const controller = new AgentKitClient({
  transport: createAgentNativeAgentKitTransport({ browserTabId: getBrowserTabId() }),
});
const evidence: Record<string, unknown> = {};
function usesCustomerGreeting(version: RecipeVersion) {
  const reply = version.steps.find(s => s.kind === "action" && s.action === "send-reply");
  const args = reply?.kind === "action" ? JSON.stringify(reply.args) : "";
  return version.steps.some(s => s.kind === "action" && s.action === "get-customer" && args.includes(`steps.${s.id}.output.name`));
}
function watch(threadId: string) {
  const observed = new Set<string>();
  return controller.subscribe(() => {
    for (const tool of Object.values(controller.getThread(threadId).tools)) {
      const key = `${tool.id}:${tool.status}`;
      if (observed.has(key)) continue;
      observed.add(key);
      console.log(JSON.stringify({ tool: tool.name, status: tool.status }));
    }
  });
}
async function send(threadId: string, text: string) {
  const handle = await controller.sendMessage({ threadId, text });
  await handle.completed;
}
try {
  const requests = await action<Request[]>("list-requests");
  const eligible = requests.filter(r => r.status === "open" && r.content.source === "structured" && r.content.fields.type === "address_change");
  const original = eligible[0];
  const target = eligible.find(r => r.orderId !== original?.orderId);
  assert(original && target && target.content.source === "structured", "Two open structured address changes required");
  const source = await action<Request>("create-request", { customerId: original.customerId, subject: original.subject, content: original.content }, false);
  const processing = await action<{ requestId: string; matchReason: string; state: string }[]>("list-request-processing", { requestIds: [source.id] });
  assert(processing.some(p => p.requestId === source.id && p.matchReason === "no_match" && p.state === "with_agent"));
  await writeClientAppState("navigation", { view: "request", requestId: source.id, path: `/requests/${source.id}` }, { requestSource: getBrowserTabId() });
  const teach = await action<Demonstration>("start-demonstration", { requestId: source.id }, false);
  await assert.rejects(action("start-demonstration", { requestId: source.id }, false));
  await action("cancel-demonstration", { demonstrationId: teach.id }, false);
  const restarted = await action<Demonstration>("start-demonstration", { requestId: source.id }, false);
  await action("cancel-demonstration", { demonstrationId: restarted.id }, false);
  assert.equal((await fetch(`${origin}/inbox`, { headers: { Accept: "text/html" } })).status, 200);
  const thread = await controller.createThread();
  await controller.loadThread(thread.id);
  Object.assign(evidence, { requestId: source.id, targetRequestId: target.id, handlingThreadId: thread.id, model: process.env.AGENT_MODEL });
  console.log(JSON.stringify({ phase: "handle-with-agent", ...evidence }));
  const stopHandling = watch(thread.id);
  try {
    await send(thread.id, shopMessages.agentPrompt.replace("{{id}}", source.id) + `\nCurrent shop request: ${source.id}. Customer: ${source.customerId}. Order: ${source.orderId ?? "none"}. Before changing anything, read get-request, get-customer, get-order and get-shipment-status through their actions, even if the screen has snapshots. Read them in parallel when independent.`);
    if ((await action<Request>("get-request", { requestId: source.id })).status !== "resolved")
      await send(thread.id, "Please finish handling this address-change request using its supplied complete address, reply, tag and resolve it through the shop actions if policy permits. Preserve completed effects.");
    assert.equal((await action<Request>("get-request", { requestId: source.id })).status, "resolved", "Agent did not resolve the request");
  } finally { stopHandling(); }
  const trace = await action<Demonstration | null>("get-agent-run-demonstration", { requestId: source.id });
  assert(trace && trace.status === "completed" && trace.source?.kind === "agent_run", "No eligible completed trace");
  assert.equal(trace.source.threadId, thread.id);
  for (const name of ["get-request", "get-customer", "get-order", "get-shipment-status"])
    if (Object.values(controller.getThread(thread.id).tools).some(t => t.name === name && t.status === "completed"))
      assert(trace.steps.some(s => s.action === name), `Missing successful parallel ${name} capture`);
  assert(trace.steps.some(s => s.action === "update-shipping-address"));
  const draft = await action<RecipeDraft>("draft-recipe-from-demonstration", { demonstrationId: trace.id }, false);
  Object.assign(evidence, { demonstrationId: trace.id, source: trace.source, capturedActions: trace.steps.map(({ sequence, action, runId }) => ({ sequence, action, runId })),
    recipeId: draft.recipe.id, originalVersionId: draft.draft.id, originalDraftSteps: draft.draft.steps, ambiguities: draft.ambiguities });
  console.log(JSON.stringify({ phase: "draft", demonstrationId: trace.id, recipeId: draft.recipe.id, steps: trace.steps.map(s => s.action), ambiguities: draft.ambiguities.map(a => ({ stepId: a.stepId, kind: a.kind, argumentPath: a.argumentPath })) }));
  await writeClientAppState("navigation", { view: "recipe", recipeId: draft.recipe.id, path: `/recipes/${draft.recipe.id}` }, { requestSource: getBrowserTabId() });
  const crystallize = await controller.createThread();
  await controller.loadThread(crystallize.id);
  evidence.crystallizeThreadId = crystallize.id;
  const stopCrystallizing = watch(crystallize.id);
  let version: RecipeVersion;
  try {
    await send(crystallize.id, `${recipeMessages.crystallizePrompt}\nContext: ${JSON.stringify({ workflow: "crystallize", recipeId: draft.recipe.id, draftId: draft.draft.id, originalVersionId: draft.draft.id, revision: 0, demonstrationId: trace.id, request: trace.trigger, ambiguities: draft.ambiguities })}`);
    let detail = await action<{ recipe: { activeVersionId: string | null }; history: { version: RecipeVersion }[] }>("get-recipe", { recipeId: draft.recipe.id });
    if (detail.history.length === 1) {
      await send(crystallize.id, "Reuse this address-change handling before dispatch. Use each request's complete new address, customer and order. Keep the demonstrated tag. Use the customer name for greetings. Please save through Studio and dry-run another structured address-change request.");
      detail = await action("get-recipe", { recipeId: draft.recipe.id });
    }
    assert(detail.history.length > 1, "Agent did not save a crystallized version");
    version = detail.history[detail.history.length - 1]!.version;
    if (!usesCustomerGreeting(version)) {
      evidence.greetingCorrection = `Saved v${version.version} did not bind the greeting to a customer lookup; matching the recipient name on this seed is insufficient evidence.`;
      await send(crystallize.id, "The saved recipe still needs a get-customer step for its greeting. The shipping recipient can differ from the customer. Follow the crystallize skill's customer-source rule: use the customer record selected by trigger.customerId, then update/save through Studio and repeat the different-request dry run. Keep the same address-change handling and tag.");
      detail = await action("get-recipe", { recipeId: draft.recipe.id });
      version = detail.history[detail.history.length - 1]!.version;
    }
    assert.equal(detail.recipe.activeVersionId, null, "No implicit activation");
    evidence.activeVersionId = detail.recipe.activeVersionId;
    evidence.proposalWidget = Object.values(controller.getThread(crystallize.id).widgets).some(w => w.kind === "muscle-memory.recipe-proposal");
  } finally { stopCrystallizing(); }
  const trigger = buildRequestTrigger(target.content.fields as unknown as JsonObject, { requestId: target.id, customerId: target.customerId, subject: target.subject });
  const before = await action("get-request-activity", { requestId: target.id });
  const beforeOrder = await action<Order>("get-order", { orderId: target.orderId });
  const run = await action<Run>("run-recipe", { recipe: version, trigger, dryRun: true }, false);
  const after = await action("get-request-activity", { requestId: target.id });
  const afterOrder = await action<Order>("get-order", { orderId: target.orderId });
  Object.assign(evidence, { savedVersionId: version.id, savedVersion: version.version, noTargetWrites: isDeepStrictEqual(before, after) && isDeepStrictEqual(beforeOrder, afterOrder),
    savedSteps: version.steps, customerGreetingBindingVerified: usesCustomerGreeting(version),
    dryRun: { requestId: target.id, runId: run.id, status: run.status, tokens: run.tokens, steps: run.steps.map(({ action, input, status }) => ({ action, input, status })) } });
  const update = run.steps.find(s => s.action === "update-shipping-address");
  const customer = await action<Customer>("get-customer", { customerId: target.customerId });
  const reply = run.steps.find(s => s.action === "send-reply")?.input as { template?: string; variables?: Record<string, string | number> } | undefined;
  const rendered = reply?.template?.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, key) => String(reply.variables?.[key] ?? placeholder));
  const address = target.content.fields.type === "address_change" ? target.content.fields.address : null;
  evidence.correct = run.status === "completed" && run.tokens.input === 0 && run.tokens.output === 0 && evidence.noTargetWrites &&
    usesCustomerGreeting(version) &&
    isDeepStrictEqual((update?.input as { address?: unknown })?.address, address) &&
    Boolean(rendered?.includes(customer.name.split(" ")[0]!) && address && rendered.includes(address.line1) && rendered.includes(address.city)) &&
    run.steps.filter(s => ["send-reply", "tag-request", "set-request-status"].includes(s.action ?? "")).every(s => (s.input as JsonObject).requestId === target.id);
  console.log(JSON.stringify({ phase: "result", ...evidence, originalDraftSteps: undefined, savedSteps: undefined, ambiguities: undefined }));
  assert(evidence.correct, "Different-request dry run failed independent checks");
} finally {
  await writeFile(new URL("agent-crystallize-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
  await controller.dispose();
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
}
