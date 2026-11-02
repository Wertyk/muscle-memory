/* oxlint-disable unicorn/no-thenable -- Recipe branch fixtures use a non-callable then array. */
import type { JsonValue } from "@muscle-memory/recipe-engine";
import { describe, expect, it } from "vitest";

import {
  circuitLanes, circuitRoundedPath, circuitHighlightReducer, circuitPaths, circuitSelection, circuitSourceExample,
  circuitTargetId, emptyCircuitHighlight, recipeCircuit,
} from "./recipe-circuit";
import { formulaLabel, presentationContext } from "./recipe-presentation";

const path = (path: string) => ({ mode: "path", path });
const fixed = (value: JsonValue) => ({ mode: "fixed", value });
const expression = { round: [{ "*": [{ var: "steps.order.output.total.amountMinor" }, { var: "trigger.quantity" }, 0.5] }] };
const content = { steps: [
  { id: "order", kind: "action", action: "get-order", args: { orderId: path("trigger.orderId") } },
  { id: "refund", kind: "action", action: "issue-refund", args: {
    orderId: path("trigger.orderId"), reason: fixed("Damaged item"),
    amount: { amountMinor: { mode: "expr", expr: expression }, currency: path("steps.order.output.total.currency") },
  }, approval: { var: "trigger.approvalOnly" } },
  { id: "reply", kind: "action", action: "send-reply", args: {
    template: { mode: "template", template: "Hi {{ trigger.customerName }}, {{steps.refund.output.amount}} for {{trigger.productId}}. {{trigger.customerName}}" },
    literal: "no binding", nested: [{ name: path("steps.order.output.items[0].name") }],
  } },
  { id: "stop", kind: "handoff", note: path("trigger.handoffOnly") },
] };
describe("recipe circuit sources", () => {
  it("collects only referenced request fields, step outputs and fixed constants, deduplicating shared sources", () => {
    const model = recipeCircuit(content, { order: "Look up order" });
    expect(model.sources.filter((source) => source.path === "trigger.orderId")).toHaveLength(1);
    expect(model.edges.filter((edge) => edge.sourceId === "path:trigger.orderId")).toHaveLength(2);
    expect(model.sources.find((source) => source.path === "steps.order.output.total.currency"))
      .toMatchObject({ group: "Step outputs", label: "Total · currency", producer: { id: "order", label: "Look up order", order: 1 },
        accessibleName: "01 Look up order · Total · currency" });
    expect(model.sources.find((source) => source.path === "trigger.orderId"))
      .toMatchObject({ label: "Order ID", accessibleName: "Request · Order ID" });
    expect(model.sources.find((source) => source.value === "Damaged item")).toMatchObject({ group: "Constants", label: "Reason", mode: "constant" });
    expect(model.sources.some((source) => source.path?.includes("Only"))).toBe(false);
    expect(model.targets.some((target) => target.id.includes("literal"))).toBe(false);
  });
  it("keeps equal constants for different arguments separate and summarizes template syntax safely", () => {
    const model = recipeCircuit({ steps: [{ kind: "action", args: {
      reason: fixed("same"), tag: fixed("same"), nested: { tag: fixed("same") },
      template: fixed("Hello {{name}}, {{outcome}} — Kiln & Co."),
    } }, { kind: "action", args: { tag: fixed("same") } }] });
    const constants = model.sources.filter((source) => source.value === "same");
    expect(constants.map((source) => source.label)).toEqual(["Reason", "Tag", "Nested · tag"]);
    const tag = constants.find((source) => source.label === "Tag")!;
    expect(model.edges.filter((edge) => edge.sourceId === tag.id)).toHaveLength(2);
    expect(circuitSourceExample(model.sources.find((source) => source.label === "Reply")!, {})).toBe("Message template · 2 variables");
  });
  it("connects several formula inputs to one operation, and one edge per template variable", () => {
    const model = recipeCircuit(content);
    expect(model.targets.find((target) => target.mode === "formula"))
      .toMatchObject({ formula: "× 0.5", sourceIds: ["path:steps.order.output.total.amountMinor", "path:trigger.quantity"], stepOrder: 1 });
    const template = model.targets.find((target) => target.mode === "template")!;
    expect(template.sourceIds).toEqual(["path:trigger.customerName", "path:steps.refund.output.amount", "path:trigger.productId"]);
    expect(model.edges.filter((edge) => edge.targetId === template.id)).toHaveLength(3);
  });
  it("traverses nested object/array bindings, extract inputs and both branch arms without wiring approval/handoff rows", () => {
    const model = recipeCircuit({ steps: [{ id: "branch", kind: "branch", condition: { ">": [{ var: "trigger.quantity" }, 0] },
      then: content.steps, else: [{ id: "extract", kind: "extract", text: path("trigger.message") }],
    }] });
    expect(model.targets[0]?.id).toBe(circuitTargetId(["steps", 0, "condition"]));
    expect(model.targets.some((target) => target.id === circuitTargetId(["steps", 0, "then", 2, "args", "nested", 0, "name"]))).toBe(true);
    expect(model.sources.some((source) => source.path === "steps.order.output.items.0.name")).toBe(true);
    expect(model.targets[model.targets.length - 1]?.id).toBe(circuitTargetId(["steps", 0, "else", 0, "text"]));
    expect(model.targets.map((target) => target.stepOrder)).toEqual(model.targets.map((target) => target.stepOrder).sort((a, b) => a - b));
  });
  it("reads demonstration examples from already loaded evidence, preserving false/zero/null and no invented outputs", () => {
    const model = recipeCircuit(content);
    const context = presentationContext({ trigger: { orderId: "ord_new" }, steps: [] }, {
      trigger: { orderId: "ord_1042", quantity: 0, customerName: null }, steps: [
        { id: "order", input: {}, output: { items: [{ name: "Platter" }], total: { currency: "EUR" } } },
      ],
    });
    const example = (key: string) => circuitSourceExample(model.sources.find((source) => source.path === key)!, context);
    expect(example("trigger.orderId")).toBe("ord_1042");
    expect(example("trigger.quantity")).toBe("0");
    expect(example("trigger.customerName")).toBe("—");
    expect(example("steps.order.output.items.0.name")).toBe("Platter");
    expect(example("steps.refund.output.amount")).toBeUndefined();
    expect(circuitSourceExample({ id: "false", group: "Constants", label: "Flag", mode: "constant", value: false }, {})).toBe("false");
  });
  it("tolerates empty/invalid editable drafts and keeps a reference-free expression as a formula node", () => {
    expect(recipeCircuit(null)).toEqual({ sources: [], targets: [], edges: [] });
    expect(() => recipeCircuit({ steps: [null, { kind: "action", args: { broken: { mode: "path", path: null }, template: { mode: "template", template: 0 } } }] })).not.toThrow();
    expect(recipeCircuit({ steps: [{ kind: "action", args: { value: { mode: "expr", expr: { "+": [1, 2] } } } }] }).targets[0]?.formula).toBe("1 + 2");
    expect(formulaLabel({ firstWord: [{ var: "trigger.customerName" }] })).toBe("First name");
  });
});

describe("circuit geometry", () => {
  it("assigns lower rail sources nearer lanes at 7px pitch, independent of insertion order", () => {
    const sources = new Map([["top", { x: 200, y: 10 }], ["bottom", { x: 200, y: 90 }], ["middle", { x: 200, y: 50 }]]);
    expect([...circuitLanes(sources, { left: 208, right: 278 })]).toEqual([["bottom", 208], ["middle", 215], ["top", 222]]);
    expect([...circuitLanes(sources, { left: 208, right: 216 }).values()]).toEqual([208, 212, 216]);
  });
  it("rounds orthogonal corners with 6px fillets and retains fractional port centres", () => {
    expect(circuitRoundedPath([{ x: 200.25, y: 33.5 }, { x: 220.25, y: 33.5 }, { x: 220.25, y: 1042.125 }]))
      .toBe("M 200.25 33.5 L 214.25 33.5 Q 220.25 33.5 220.25 39.5 L 220.25 1042.125");
  });
  it("draws one shared trunk with separate rounded branches and junctions for a reused source", () => {
    const model = recipeCircuit({ steps: [
      { kind: "action", args: { requestId: path("trigger.requestId") } },
      { kind: "action", args: { requestId: path("trigger.requestId") } },
    ] });
    const paths = circuitPaths(model, { sources: new Map([["path:trigger.requestId", { x: 200, y: 50 }]]),
      targets: new Map(model.targets.map((target, index) => [target.id, { x: 330, y: 100 + index * 100 }])), formulas: new Map(),
    }, { left: 208, right: 278 });
    expect(paths.filter((path) => path.kind === "trunk")).toEqual([
      { id: "trunk:path:trigger.requestId", kind: "trunk", d: "M 200 50 L 204 50 Q 208 50 208 54 L 208 194" },
    ]);
    expect(paths.filter((path) => path.kind === "branch")).toHaveLength(2);
    expect(paths[0]).toMatchObject({ d: "M 208 94 Q 208 100 214 100 L 330 100", junction: { x: 208, y: 94 } });
    expect(paths[1]).toMatchObject({ d: "M 208 194 Q 208 200 214 200 L 330 200", junction: { x: 208, y: 194 } });
  });
  it("routes every formula input to the pill and exactly one outgoing wire to the argument", () => {
    const model = recipeCircuit({ steps: [{ kind: "action", args: { amount: { mode: "expr", expr: expression } } }] });
    const target = model.targets[0]!;
    const paths = circuitPaths(model, {
      sources: new Map(target.sourceIds.map((id, i) => [id, { x: 200, y: 40 + i * 60 }])),
      targets: new Map([[target.id, { x: 388, y: 2000 }]]),
      formulas: new Map([[target.id, { input: { x: 300, y: 2000 }, output: { x: 360, y: 2000 } }]]),
    }, { left: 208, right: 278 });
    expect(paths).toHaveLength(5);
    expect(paths.filter((path) => path.kind === "branch").map((path) => path.d))
      .toEqual(["M 215 1994 Q 215 2000 221 2000 L 300 2000", "M 208 1994 Q 208 2000 214 2000 L 300 2000"]);
    expect(paths.find((path) => path.kind === "formula")).toEqual({ id: `formula:${target.id}`, kind: "formula", d: "M 360 2000 L 388 2000" });
  });
  it("omits missing/hidden ports without dangling trunks", () => {
    const model = recipeCircuit(content);
    const edge = model.edges[0]!;
    const paths = circuitPaths(model, { sources: new Map([[edge.sourceId, { x: 200, y: 0 }]]),
      targets: new Map(), formulas: new Map() }, { left: 208, right: 278 });
    expect(paths).toEqual([]);
  });
  it("shares a single bus when destinations are both above and below its source", () => {
    const model = recipeCircuit({ steps: [{ kind: "action", args: { a: path("trigger.orderId"), b: path("trigger.orderId") } }] });
    const paths = circuitPaths(model, { sources: new Map([["path:trigger.orderId", { x: 200, y: 100 }]]),
      targets: new Map(model.targets.map((target, index) => [target.id, { x: 330, y: 50 + index * 150 }])), formulas: new Map(),
    }, { left: 208, right: 278 });
    expect(paths.find((path) => path.kind === "trunk")?.d).toBe("M 200 100 L 208 100 M 208 56 L 208 194");
  });
});

describe("circuit highlighting", () => {
  it("gives a pin priority over focus/hover, switches pins, and clears on a second click or Escape", () => {
    const a = "path:trigger.orderId", b = "path:trigger.quantity";
    let state = circuitHighlightReducer(emptyCircuitHighlight, { type: "hover", id: a });
    state = circuitHighlightReducer(state, { type: "focus", id: b });
    state = circuitHighlightReducer(state, { type: "pin", id: a });
    expect(circuitSelection(recipeCircuit(content), state).id).toBe(a);
    state = circuitHighlightReducer(state, { type: "pin", id: b });
    expect(state.pinned).toBe(b);
    expect(circuitHighlightReducer(state, { type: "pin", id: b })).toEqual(emptyCircuitHighlight);
    expect(circuitHighlightReducer(state, { type: "clear" })).toEqual(emptyCircuitHighlight);
    expect(circuitSelection(recipeCircuit(null), state).id).toBeNull();
  });
  it("selects both endpoints and all connected wires for a source or argument, leaving other wires dimmable", () => {
    const model = recipeCircuit(content);
    const source = circuitSelection(model, { ...emptyCircuitHighlight, hovered: "path:trigger.orderId" });
    expect(source.edges.size).toBe(2);
    const formula = model.targets.find((target) => target.mode === "formula")!;
    const argument = circuitSelection(model, { ...emptyCircuitHighlight, focused: formula.id });
    expect(argument.edges.size).toBe(2);
    expect([...argument.nodes]).toEqual(expect.arrayContaining([formula.id, ...formula.sourceIds]));
  });
});
