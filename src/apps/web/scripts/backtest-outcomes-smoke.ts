// Opt-in real-extractor rehearsal. Run after seed:shop --all and seed-backtests.ts,
// with dev listening on 8099. Uses normal authenticated frontend actions throughout.
// Or --repeat <Teach version ID> for three read-only passes per saved recipe.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Demonstration, RecipeDraft, RecipeVersion, StudioDraft } from "@muscle-memory/recipe-engine";
import type { Order, Refund, Request } from "@muscle-memory/shop-domain";
import { Window } from "happy-dom";
import type { ShopBacktestComparison, ShopBacktestResult } from "../shared/recipe-backtests.js";

const origin = "http://localhost:8099";
const nativeFetch = globalThis.fetch;
const cookies = new Map<string, string>();
const saved = new Map<string, PropertyDescriptor | undefined>();
let dom: Window | undefined;
let stage = "authenticated landing";
function remember(response: Response) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
}
function evidence(report: ShopBacktestResult) {
  return { recipeVersionId: report.recipeVersionId, summary: report.summary,
    cases: report.cases.map((item) => ({ caseId: item.caseId, status: item.status,
      reconstructionFailure: item.reasons.find((reason) => reason.code === "reconstruction-failed")?.message ?? null,
      outcomeDifferences: item.diff.filter((diff) => diff.classification === "outcome"),
      bookkeepingDifferences: item.diff.filter((diff) => diff.classification === "bookkeeping").length,
      wordingDifferences: item.diff.filter((diff) => diff.classification === "wording").length })) };
}
try {
  const signIn = await nativeFetch(`${origin}/sign-in`, { redirect: "manual", headers: { Accept: "text/html" } });
  remember(signIn);
  if (!cookies.size) {
    // The same Continue as local dev endpoint used by the shared sign-in page.
    const local = await nativeFetch(`${origin}/_agent-native/auth/local-dev`, {
      method: "POST", headers: { origin, referer: `${origin}/sign-in` },
    });
    assert(local.ok, "Normal local development sign-in must succeed");
    remember(local);
  }
  assert(cookies.size, "Local sign-in must issue the development session");
  const inbox = await nativeFetch(`${origin}/inbox`, { headers: { cookie: [...cookies.values()].join("; ") } });
  assert(inbox.ok, "Authenticated inbox must load");
  dom = new Window({ url: `${origin}/requests/req_0001` });
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", [...cookies.values()].join("; "));
    headers.set("origin", origin);
    headers.set("referer", `${origin}/requests/req_0001`);
    const response = await nativeFetch(new URL(String(input), origin), { ...init, headers });
    remember(response);
    return response;
  };
  const { callAction, getBrowserTabId, writeClientAppState } = await import("@agent-native/core/client/hooks");
  const query = <T>(name: string, input: object) => callAction<T>(name, input, { method: "GET" });
  const mutate = <T>(name: string, input: object) => callAction<T>(name, input, { uiOnly: true });
  const backtest = async (recipe: string) => {
    const result = await query<ShopBacktestResult>("backtest-recipe", { recipe, requestType: "damaged_item" });
    assert.equal(result.summary.total, 10);
    assert.equal(result.cases.length, 10);
    assert.equal(result.summary.sameOutcome + result.summary.differentOutcome + result.summary.notHandled, 10);
    for (const item of result.cases) if (item.status !== "not_handled")
      assert.equal(item.status, ["req_0038", "req_0039"].includes(item.caseId) ? "different" : "identical");
    assert.equal(result.summary.totalTokens === null, result.summary.unknownUsageCases > 0);
    return result;
  };
  if (process.argv[2] === "--repeat") {
    const taught = process.argv[3];
    assert(taught, "Supply the exact saved Teach version ID");
    const failures: Record<string, number> = {};
    let notHandled = 0;
    for (let run = 1; run <= 3; run++) for (const [label, recipe] of [["teach", taught], ["fixture", "ver_backtest_damaged"]] as const) {
      stage = `${label} repeat ${run}`;
      const report = await backtest(recipe);
      for (const item of report.cases) if (item.status === "not_handled") {
        failures[`${label}:${item.caseId}`] = (failures[`${label}:${item.caseId}`] ?? 0) + 1;
        notHandled++;
      }
      console.log(JSON.stringify({ run, label, ...evidence(report) }));
    }
    console.log(JSON.stringify({ runsPerRecipe: 3, totalCases: 60, notHandled, failures }));
  } else {
  await writeClientAppState("navigation", { view: "request", requestId: "req_0001", path: "/requests/req_0001" }, { requestSource: getBrowserTabId() });
  stage = "Teach refund, reply and tag";
  const source = JSON.parse(await readFile(new URL("../server/fixtures/broken-platter-demonstration.json", import.meta.url), "utf8")) as Demonstration;
  const text = (action: string, field: string) => {
    const value = source.steps.find((step) => step.action === action)?.input[field];
    assert(typeof value === "string");
    return value;
  };
  const recording = await mutate<Demonstration>("start-demonstration", { requestId: "req_0001" });
  await assert.rejects(() => mutate("start-demonstration", { requestId: "req_0001" }));
  const request = await query<Request>("get-request", { requestId: "req_0001" });
  const order = await query<Order>("get-order", { orderId: request.orderId });
  const refetch = () => Promise.all([
    query("get-request", { requestId: request.id }), query("get-order", { orderId: order.id }),
    query("get-shipment-status", { orderId: order.id }), query("get-customer", { customerId: request.customerId }),
    query("get-request-activity", { requestId: request.id }),
  ]);
  await refetch();
  assert(request.content.source === "structured" && request.content.fields.type === "damaged_item");
  const productId = request.content.fields.productId;
  const amountMinor = Math.round(order.items.find((item) => item.productId === productId)!.unitPrice.amountMinor * 0.5);
  assert.equal(amountMinor, 14000);
  const refund = await mutate<Refund>("issue-refund", { orderId: order.id,
    amount: { amountMinor, currency: order.paid.currency }, reason: text("issue-refund", "reason") });
  assert.equal(refund.amount.amountMinor, amountMinor);
  await refetch();
  await mutate("send-reply", { requestId: request.id, template: text("send-reply", "template"), variables: {} });
  await refetch();
  await mutate("tag-request", { requestId: request.id, tag: text("tag-request", "tag") });
  await refetch();
  await mutate("stop-demonstration", { demonstrationId: recording.id });
  const trace = await query<Demonstration>("get-demonstration", { demonstrationId: recording.id });
  assert.equal(trace.status, "completed");
  assert.equal(trace.steps.length, 8);
  assert.deepEqual(trace.steps.slice(5).map((step) => step.action), ["issue-refund", "send-reply", "tag-request"]);
  stage = "draft, keyed half-price binding and save";
  const drafted = await mutate<RecipeDraft>("draft-recipe-from-demonstration", { demonstrationId: trace.id });
  const draft = await query<StudioDraft>("get-recipe-draft", { recipeId: drafted.recipe.id });
  // Agent-free edit of the actual Teach draft, preserving its reply and tag.
  const content = structuredClone(draft.content);
  assert(Array.isArray(content.steps));
  const refundStep = content.steps.find((step) => step && typeof step === "object" && !Array.isArray(step) && step.action === "issue-refund");
  assert(refundStep && typeof refundStep === "object" && !Array.isArray(refundStep));
  const args = refundStep.args;
  assert(args && typeof args === "object" && !Array.isArray(args));
  args.amount = {
    amountMinor: { mode: "expr", expr: { "*": [{ find: [{ var: "steps.step_2.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor"] }, 0.5] } },
    currency: { mode: "expr", expr: { find: [{ var: "steps.step_2.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.currency"] } },
  };
  const edited = await mutate<StudioDraft & { issues: unknown[] }>("update-recipe-draft", { recipeId: draft.recipeId, expectedRevision: draft.revision, content });
  assert.equal(edited.issues.length, 0);
  const version = await mutate<RecipeVersion>("save-recipe-version", { recipeId: draft.recipeId, expectedRevision: edited.revision });
  const detail = await query<{ history: { version: RecipeVersion }[] }>("get-recipe", { recipeId: draft.recipeId });
  assert(detail.history.some((item) => item.version.id === version.id));
  stage = "real-extractor Teach backtest";
  const teach = await backtest(version.id);
  console.log(JSON.stringify({ teach: evidence(teach), demonstrationId: trace.id, recipeId: draft.recipeId, edit: "update-recipe-draft; keyed 50% unit price; original Teach reply/tag retained" }));
  stage = "real-extractor seed-backtests fixture";
  const fixture = await backtest("ver_backtest_damaged");
  console.log(JSON.stringify({ fixture: evidence(fixture) }));
  stage = "wording-only version comparison";
  const current = await query<StudioDraft>("get-recipe-draft", { recipeId: draft.recipeId });
  const replyContent = structuredClone(current.content);
  assert(Array.isArray(replyContent.steps));
  const replyStep = replyContent.steps.find((step) => step && typeof step === "object" && !Array.isArray(step) && step.action === "send-reply");
  assert(replyStep && typeof replyStep === "object" && !Array.isArray(replyStep));
  const replyArgs = replyStep.args;
  assert(replyArgs && typeof replyArgs === "object" && !Array.isArray(replyArgs));
  replyArgs.template = { mode: "fixed", value: "A revised reply for comparison." };
  const replyEdit = await mutate<StudioDraft>("update-recipe-draft", { recipeId: draft.recipeId, expectedRevision: current.revision, content: replyContent });
  const candidate = await mutate<RecipeVersion>("save-recipe-version", { recipeId: draft.recipeId, expectedRevision: replyEdit.revision });
  // Studio compares saved IDs; avoid putting the large Teach snapshot in a GET URL.
  const comparison = await query<ShopBacktestComparison>("compare-recipe-versions", { baseline: version.id, candidate: candidate.id, requestType: "damaged_item" });
  console.log(JSON.stringify({ comparison: { changed: comparison.cases.filter((item) => item.changed).length,
    nonOutcomeOnly: comparison.cases.filter((item) => item.nonOutcomeOnly).length, summary: comparison.summary } }));
  assert(comparison.cases.every((item) => !item.changed && (item.nonOutcomeOnly || item.baselineStatus === "not_handled")));
  stage = "cancellation frees Teach slot";
  const cancelled = await mutate<Demonstration>("start-demonstration", { requestId: request.id });
  await mutate("cancel-demonstration", { demonstrationId: cancelled.id });
  const restarted = await mutate<Demonstration>("start-demonstration", { requestId: request.id });
  await mutate("stop-demonstration", { demonstrationId: restarted.id });
  console.log(JSON.stringify({ authenticatedLanding: true, overlapRejected: true, cancellationFreedSlot: true, capturedSteps: trace.steps.length, refundAmountMinor: amountMinor }));
  }
} catch {
  console.error(`Backtest outcome smoke failed at: ${stage}. Credential and response details withheld.`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom?.happyDOM.close();
}
// Framework client session timers otherwise keep this opt-in script alive.
process.exit(process.exitCode ? 1 : 0);
