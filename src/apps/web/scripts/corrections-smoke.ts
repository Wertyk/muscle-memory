/** Opt-in TASK-17 live proof. Start a seeded, isolated app on port 8096.
 * Run from apps/web: node --env-file=.env --import tsx scripts/corrections-smoke.ts
 * Native frontend actions + real agent-chat transport. Never used by tests.
 * Leaves synthetic evidence for review; logs only IDs, tool status and assertions.
 */
import assert from "node:assert/strict";
import { AgentKitClient } from "@agent-native/agentkit";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import type { Demonstration, RecipeDraft, RecipeVersion, Run } from "@muscle-memory/recipe-engine";
import type { Customer, Order, Request } from "@muscle-memory/shop-domain";
import type { CorrectionEvidence } from "../shared/corrections.js";
import type { RequestProcessing } from "../shared/request-processing.js";
import type { RecipeDetail } from "../app/lib/recipe-studio.js";
import { Window } from "happy-dom";
const origin = "http://localhost:8096";
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
  transport: createAgentNativeAgentKitTransport(),
});
async function openRequest(requestId: string) {
  await writeClientAppState("navigation", { view: "request", requestId, path: `/requests/${requestId}` }, { requestSource: getBrowserTabId() });
}
function actions(steps: RecipeVersion["steps"]): Extract<RecipeVersion["steps"][number], { kind: "action" }>[] {
  return steps.flatMap(step => step.kind === "action" ? [step] : step.kind === "branch" ? [...actions(step.then), ...actions(step.else)] : []);
}
const refundCorrection = process.argv.includes("--refund");
let activeDemonstrationId: string | null = null;
try {
  const requests = await action<Request[]>("list-requests");
  const source = requests.find(request => request.id === "req_0011");
  assert(source && source.content.source === "structured" && source.content.fields.type === "damaged_item");
  const productId = source.content.fields.productId;
  await openRequest(source.id);
  const demo = await action<Demonstration>("start-demonstration", { requestId: source.id }, false);
  activeDemonstrationId = demo.id;
  await assert.rejects(action("start-demonstration", { requestId: source.id }, false));
  await action("cancel-demonstration", { demonstrationId: demo.id }, false);
  const recording = await action<Demonstration>("start-demonstration", { requestId: source.id }, false);
  activeDemonstrationId = recording.id;
  await action("get-request", { requestId: source.id });
  const order = await action<Order>("get-order", { orderId: source.orderId });
  const customer = await action<Customer>("get-customer", { customerId: source.customerId });
  const product = order.items.find(item => item.productId === productId)!;
  const amountMinor = Math.round(product.unitPrice.amountMinor / 2);
  await action("issue-refund", { orderId: order.id, reason: "Damaged item: half of its price", amount: { amountMinor, currency: product.unitPrice.currency } }, false);
  await action("send-reply", { requestId: source.id, template: `Hi ${customer.name.split(" ")[0]}, I am sorry your ${product.name} arrived damaged. We refunded $${(amountMinor / 100).toFixed(2)}, half of its price. Warmly, Kiln & Co.`, variables: {} }, false);
  await action("tag-request", { requestId: source.id, tag: "damaged" }, false);
  await action("stop-demonstration", { demonstrationId: recording.id }, false);
  activeDemonstrationId = null;
  const draft = await action<RecipeDraft>("draft-recipe-from-demonstration", { demonstrationId: recording.id }, false);
  await action("activate-recipe", { recipeId: draft.recipe.id, versionId: draft.draft.id }, false);
  const batch = await action<Request[]>("demo-intake", {}, false);
  const processing = await action<RequestProcessing[]>("list-request-processing", { requestIds: batch.map(request => request.id) });
  const automatic = processing.find(row => row.state === "auto_handled");
  assert(automatic, "A new damaged request must be auto-handled by the learned recipe");
  const run = await action<Run>("get-recipe-run", { runId: automatic.runId });
  const original = run.steps.find(step => step.action === "send-reply")!;
  assert(original.output && typeof original.output === "object" && !Array.isArray(original.output));
  const originalBody = String((original.output as { body: unknown }).body);
  assert(originalBody.includes("half of its price"));
  await openRequest(automatic.requestId);
  if (refundCorrection) {
    const refund = run.steps.find(step => step.action === "issue-refund")!;
    const input = refund.input as { orderId: string; amount: { amountMinor: number; currency: string } };
    await action("issue-refund", { orderId: input.orderId, reason: "Additional damaged-item compensation", amount: { amountMinor: Math.round(input.amount.amountMinor / 2), currency: input.amount.currency } }, false);
  } else {
    await action("send-reply", { requestId: automatic.requestId, template: `${originalBody} Please keep the piece; no return needed.`, variables: {} }, false);
  }
  const corrected = await action<Request & CorrectionEvidence>("get-request", { requestId: automatic.requestId });
  const correction = corrected.corrections?.[0];
  assert(correction && correction.runId === run.id && correction.recipe.id === run.recipe.id && correction.stepId === (refundCorrection ? run.steps.find(step => step.action === "issue-refund")!.stepId : original.stepId));
  assert.equal((await action<Run & CorrectionEvidence>("get-recipe-run", { runId: run.id })).corrections?.[0]?.id, correction.id);
  const before = await action<RecipeDetail>("get-recipe", { recipeId: correction.recipe.recipeId });
  const thread = await controller.createThread();
  await controller.loadThread(thread.id);
  const seen = new Set<string>();
  const unsubscribe = controller.subscribe(() => {
    for (const tool of Object.values(controller.getThread(thread.id).tools)) {
      const key = `${tool.id}:${tool.status}`;
      if (!seen.has(key)) { seen.add(key); console.log(JSON.stringify({ tool: tool.name, status: tool.status })); }
    }
  });
  try {
    const instructions = refundCorrection ? "Propose a reusable recipe update from this additional refund correction. Read get-request/get-recipe/get-recipe-draft and inspect the pinned run/version. The operator wants TOTAL compensation of 75% of the damaged item price; the correction is an additional refund, not a replacement amount. Generalise the total into a price/quantity formula using the matching trigger product, retaining dynamic bindings. Update the existing refund step, do not append another top-up step. Update the reply policy wording to reflect the new percentage. Use update-recipe-draft then save-recipe-version with correctionId and proposal notes. Do not activate. Show the proposal card and Studio history diff." : "Propose a reusable recipe update for this recorded operator correction. Read get-request/get-recipe/get-recipe-draft. Preserve dynamic greeting, product, money and refund policy; append the no-return sentence to the reply template. Use update-recipe-draft, then save-recipe-version with correctionId and proposal notes (description, trigger, resolutions). Show the proposal card and link to its Studio history diff. Do not activate or ask for approval to save a proposal. This correction only changes reusable reply wording.";
    const handle = await controller.sendMessage({ threadId: thread.id, text: `${instructions}\nContext: ${JSON.stringify({ workflow: "correct-recipe", correction })}` });
    await handle.completed;
  } finally { unsubscribe(); }
  const detail = await action<RecipeDetail>("get-recipe", { recipeId: correction.recipe.recipeId });
  assert.equal(detail.history.length, before.history.length + 1, "Live agent saves one new version");
  const proposed = detail.corrections?.find(row => row.id === correction.id);
  assert(proposed);
  assert.equal(proposed.status, "proposed");
  const saved = detail.history.find(entry => entry.version.id === proposed.proposal?.version.id)!;
  assert(saved.diff.length > 0);
  assert.equal(detail.recipe.activeVersionId, run.recipe.id, "No implicit activation");
  const changedStep = actions(saved.version.steps).find(step => step.id === correction.stepId)!;
  const oldStep = actions(run.recipe.steps).find(step => step.id === correction.stepId)!;
  if (refundCorrection) {
    assert(JSON.stringify(changedStep.args.amount).includes('"mode":"expr"'));
    const dry = await action<Run>("run-recipe", { recipe: saved.version, trigger: { ...(run.trigger as object), requestId: source.id, orderId: order.id, productId, quantity: 1 }, dryRun: true }, false);
    const amount = dry.steps.find(step => step.action === "issue-refund")?.input as { amount: { amountMinor: number } };
    assert.equal(amount.amount.amountMinor, Math.round(product.unitPrice.amountMinor * 0.75));
  } else {
    assert(JSON.stringify(changedStep.args).includes("Please keep the piece; no return needed."));
    assert.equal(JSON.stringify(changedStep.args.requestId), JSON.stringify(oldStep.args.requestId));
  }
  assert(Object.values(controller.getThread(thread.id).widgets).some(widget => widget.kind === "muscle-memory.recipe-proposal"), "Native chat emits proposal card");
  await action("activate-recipe", { recipeId: detail.recipe.id, versionId: saved.version.id }, false);
  const accepted = await action<RecipeDetail>("get-recipe", { recipeId: detail.recipe.id });
  assert.equal(accepted.corrections?.find(row => row.id === correction.id)?.status, "accepted");
  if (!refundCorrection) {
  await action("send-reply", { requestId: automatic.requestId, template: `${originalBody} Please contact us if you need more help.`, variables: {} }, false);
  const next = await action<Request & CorrectionEvidence>("get-request", { requestId: automatic.requestId });
  const second = next.corrections!.find(row => row.id !== correction.id)!;
  const studioDraft = await action<{ content: Record<string, any>; revision: number }>("get-recipe-draft", { recipeId: detail.recipe.id });
  const followupReply = actions(studioDraft.content.steps).find(step => step.action === "send-reply")!;
  const binding = followupReply.args.template as { mode: string; template?: string; value?: string; expr?: any; path?: string };
  if (binding.mode === "template") binding.template += " Please contact us if you need more help.";
  else if (binding.mode === "fixed") binding.value += " Please contact us if you need more help.";
  else if (binding.mode === "expr" || binding.mode === "path") {
    const expression = binding.mode === "path" ? { var: binding.path } : binding.expr;
    Object.assign(binding, { mode: "expr", expr: { cat: [expression, " Please contact us if you need more help."] } });
    delete binding.path;
  } else throw new Error("Expected a reply binding");
  const updated = await action<{ revision: number }>("update-recipe-draft", { recipeId: detail.recipe.id, expectedRevision: studioDraft.revision, content: studioDraft.content }, false);
  const rejectedVersion = await action<RecipeVersion>("save-recipe-version", { recipeId: detail.recipe.id, expectedRevision: updated.revision, correctionId: second.id, proposal: { description: "Follow-up review", trigger: "Damaged item requests", resolutions: [{ ambiguity: "Follow-up", resolution: "Operator review required." }] } }, false);
  await action("record-correction-decision", { correctionId: second.id, decision: "rejected", reason: "Keep the accepted no-return wording" }, false);
  await assert.rejects(action("activate-recipe", { recipeId: detail.recipe.id, versionId: rejectedVersion.id }, false));
  const final = await action<RecipeDetail>("get-recipe", { recipeId: detail.recipe.id });
  assert.equal(final.recipe.activeVersionId, saved.version.id);
  assert.equal(final.corrections?.find(row => row.id === second.id)?.status, "rejected");
  }
  console.log(JSON.stringify({ phase: "verified", requestId: automatic.requestId, runId: run.id, recipeId: detail.recipe.id, correctionAction: correction.action, baseVersion: run.recipe.version, proposalVersion: saved.version.version, correctionId: correction.id, threadId: thread.id, diffFields: saved.diff.length, proposalCard: true, accepted: true, rejected: !refundCorrection, implicitActivation: false, overlapRejected: true, cancellationFreedSlot: true, automaticTokens: run.tokens }));
} finally {
  if (activeDemonstrationId) await action("cancel-demonstration", { demonstrationId: activeDemonstrationId }, false).catch(() => {});
  await controller.dispose();
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
}
