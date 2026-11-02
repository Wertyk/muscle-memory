import { actionCallIntent, preparedCallArguments, validateActionArgs, type ActionDefinition } from "@agent-native/core/action";
import { actionsToEngineTools, executeAgentToolCall } from "@agent-native/core/server";
import { recipeContent } from "@muscle-memory/recipe-engine";
import { describe, expect, it } from "vitest";
import backtest from "../actions/backtest-recipe.js";
import compare from "../actions/compare-recipe-versions.js";
import replacement from "../actions/create-replacement-order.js";
import createRequest from "../actions/create-request.js";
import refund from "../actions/issue-refund.js";
import processing from "../actions/list-request-processing.js";
import provider from "../actions/provider-api-request.js";
import resume from "../actions/resume-recipe-run.js";
import run from "../actions/run-recipe.js";
import save from "../actions/save-recipe-version.js";
import reply from "../actions/send-reply.js";
import start from "../actions/start-demonstration.js";
import update from "../actions/update-recipe-draft.js";
import shipping from "../actions/update-shipping-address.js";
import { damagedItemFixture } from "./fixtures/intake-recipes.js";

type InputAction = Pick<ActionDefinition<never, unknown>, "tool">;
const address = { name: "Maya", line1: "1 Main St", city: "Portland", region: "OR", postalCode: "97201", countryCode: "US" };
const proposal = { description: "Reusable care", trigger: "Damaged item", resolutions: [{ ambiguity: "Amount", resolution: "Half price" }] };
const fields = { type: "where_is_my_order", orderId: "ord_1042" };
const cases: Array<{ name: string; action: InputAction; field: string; input: Record<string, unknown> }> = [
  { name: "update-recipe-draft", action: update, field: "content", input: { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, content: recipeContent(damagedItemFixture) } },
  { name: "save-recipe-version", action: save, field: "proposal", input: { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, proposal } },
  { name: "run-recipe snapshot", action: run, field: "recipe", input: { recipe: damagedItemFixture, trigger: { requestId: "req_0007" }, dryRun: true } },
  { name: "run-recipe trigger", action: run, field: "trigger", input: { recipe: damagedItemFixture, trigger: { requestId: "req_0007", items: [1] }, dryRun: true } },
  { name: "backtest-recipe", action: backtest, field: "recipe", input: { recipe: damagedItemFixture, requestType: "damaged_item" } },
  ...["baseline", "candidate"].map(field => ({ name: `compare-recipe-versions ${field}`, action: compare, field, input: { baseline: damagedItemFixture, candidate: damagedItemFixture, requestType: "damaged_item" } })),
  { name: "send-reply", action: reply, field: "variables", input: { requestId: "req_0007", template: "Hello {{name}}", variables: { name: "Maya" } } },
  { name: "issue-refund", action: refund, field: "amount", input: { orderId: "ord_1042", reason: "Damage", amount: { amountMinor: 500, currency: "USD" } } },
  { name: "update-shipping-address", action: shipping, field: "address", input: { orderId: "ord_1042", address } },
  { name: "create-replacement-order", action: replacement, field: "items", input: { orderId: "ord_1042", items: [{ productId: "prd_0001", quantity: 1 }] } },
  { name: "create-request", action: createRequest, field: "content", input: { customerId: "cus_0001", subject: "Where is it?", content: { source: "structured", fields } } },
  { name: "start-demonstration", action: start, field: "fields", input: { requestId: "req_0007", fields } },
  { name: "resume-recipe-run", action: resume, field: "approval", input: { runId: "run_test", approval: { stepId: "refund", decision: "approve" }, retry: false } },
  { name: "list-request-processing", action: processing, field: "requestIds", input: { requestIds: ["req_0007"] } },
  { name: "provider-api-request", action: provider, field: "headers", input: { provider: "slack", path: "/auth.test", method: "GET", headers: { Accept: "application/json" } } },
];
// Core retains the runtime schema on its action entry but omits it from ActionDefinition.
const schemaFor = (action: InputAction) => (action as InputAction & { schema: Parameters<typeof validateActionArgs>[0] }).schema;
const parse = (action: InputAction, input: unknown) => validateActionArgs(schemaFor(action), input, action.tool.parameters);

describe("action container contracts", () => {
  it("reproduces the rehearsal's missing step brace through the model-visible validation parameters", async () => {
    // Shortened from the 1902-character live content: the reply step is missing
    // its closing } before the comma introducing the next step.
    const malformed = '{"name":"Damage care","trigger":{"event":"request.created","match":true},"steps":[{"id":"reply","kind":"action","action":"send-reply","args":{"variables":{"mode":"expr","expr":{"cat":["Warmly, Kiln & Co."]}}}, {"id":"tag","kind":"action","action":"tag-request","args":{}}]}';
    expect(() => JSON.parse(malformed)).toThrow(SyntaxError);
    const tool = actionsToEngineTools({ "update-recipe-draft": update })[0]!;
    expect(tool.inputSchema.properties?.content).toMatchObject({ type: "object" });
    const input = { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, content: malformed };
    const parameters = tool.inputSchema as NonNullable<typeof update.tool.parameters>;
    let parserMessage = "";
    try { JSON.parse(malformed); } catch (error) { parserMessage = (error as SyntaxError).message; }
    const failure = await validateActionArgs(schemaFor(update), input, parameters).catch(error => error);
    expect(failure.message).toContain("Invalid action parameters — content: content was sent as a string, but it is not valid JSON");
    expect(failure.message).toContain(parserMessage);
    expect(failure.message).toContain("Send content as a JSON object, not a string.");
    expect(failure.message).not.toContain(malformed);
    expect(failure.message).not.toContain("Received:");
    const result = await executeAgentToolCall({ actions: { "update-recipe-draft": update }, name: "update-recipe-draft", input, callId: "malformed-content", caller: "tool" });
    expect(result.status).toBe("failed");
    expect(result.output).toContain(failure.message);
    const corrected = malformed.replace('}, {"id":"tag"', '}}, {"id":"tag"');
    expect(await validateActionArgs(schemaFor(update), { ...input, content: corrected }, parameters)).toEqual({ ...input, content: JSON.parse(corrected) });
  });

  it("keeps proposal object typing and rejects the same missing-brace defect on the agent path", async () => {
    const tool = actionsToEngineTools({ "save-recipe-version": save })[0]!;
    expect(tool.inputSchema.properties?.proposal).toMatchObject({ type: "object" });
    const malformed = '{"description":"Damage care","trigger":"Damaged item","resolutions":[{"ambiguity":"Amount","resolution":"Half price", {"ambiguity":"Tone","resolution":"Warm"}]}';
    expect(() => JSON.parse(malformed)).toThrow(SyntaxError);
    await expect(validateActionArgs(schemaFor(save), { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, proposal: malformed }, tool.inputSchema as NonNullable<typeof save.tool.parameters>)).rejects.toThrow("Send proposal as a JSON object, not a string.");
  });

  it.each(cases)("$name prepares native/frontend and stringified/MCP arguments identically", async ({ action, field, input }) => {
    const native = await parse(action, input);
    expect(native).toEqual(input);
    const wire = { ...input, [field]: JSON.stringify(input[field]) };
    expect(await parse(action, wire)).toEqual(native);
    // MCP and the chat loop use this same preparation before approval/execution.
    const intent = await actionCallIntent(action, wire);
    expect(intent.valid).toBe(true);
    if (!intent.valid) throw intent.error;
    expect(preparedCallArguments(intent)).toEqual(native);
    expect(wire[field]).toBeTypeOf("string");
  });

  it.each(cases.filter(({ action }) => action !== run))("$name keeps wrong-kind JSON errors", async ({ action, field, input }) => {
    for (const invalid of ["42", '"text"']) {
      const wire = { ...input, [field]: invalid };
      const original = await schemaFor(action)["~standard"].validate(wire);
      expect(original.issues).toBeDefined();
      const intent = await actionCallIntent(action, wire);
      expect(intent.valid).toBe(false);
      if (intent.valid) throw new Error("Expected invalid input");
      if (!(intent.error instanceof Error)) throw intent.error;
      for (const issue of original.issues!) expect(intent.error.message).toContain(issue.message);
    }
  });

  it.each(cases)("$name reports malformed JSON with the exact field name", async ({ action, field, input }) => {
    await expect(parse(action, { ...input, [field]: '{"broken":}' })).rejects.toThrow(`${field} was sent as a string, but it is not valid JSON`);
  });

  it("retains saved version IDs, optional proposals/items and generic provider strings", async () => {
    expect((await parse(backtest, { recipe: damagedItemFixture.id, requestType: "damaged_item" })).recipe).toBe(damagedItemFixture.id);
    expect(await parse(save, { recipeId: damagedItemFixture.recipeId, expectedRevision: 0 })).not.toHaveProperty("proposal");
    expect(await parse(replacement, { orderId: "ord_1042" })).not.toHaveProperty("items");
    expect(await parse(provider, { path: "/auth.test", query: "raw", body: "{}" })).toMatchObject({ query: "raw", body: "{}" });
  });

  it("rejects parsed values with the same schema-invalid errors", async () => {
    for (const [action, field, input] of [
      [save, "proposal", { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, proposal: { ...proposal, description: "" } }],
      [refund, "amount", { orderId: "ord_1042", reason: "Damage", amount: { amountMinor: -1, currency: "USD" } }],
      [update, "content", { recipeId: damagedItemFixture.recipeId, expectedRevision: 0, content: { name: { constructor: "unsafe" } } }],
    ] as const) {
      const original = await parse(action, input).catch(error => error);
      await expect(parse(action, { ...input, [field]: JSON.stringify(input[field]) })).rejects.toThrow(original.message);
    }
  });

  it.each(cases)("$name publishes container metadata rather than any", ({ action, field }) => {
    // defineAction exposes this schema to the model; MCP derives inputSchema from it.
    const parameters = action.tool.parameters!;
    expect(parameters.type).toBe("object");
    const property = parameters.properties![field]!;
    expect(property.type === "object" || property.type === "array" || Boolean(property.anyOf?.length) || "$ref" in property).toBe(true);
    const engineTool = actionsToEngineTools({ probe: action as Parameters<typeof actionsToEngineTools>[0][string] })[0]!;
    expect(engineTool.inputSchema.properties?.[field]).toEqual(property);
  });

  it("advertises backtest snapshots as required ID-or-object parameters", () => {
    expect(backtest.tool.parameters?.required).toEqual(["recipe", "requestType"]);
    expect(compare.tool.parameters?.required).toEqual(["baseline", "candidate", "requestType"]);
  });
});
