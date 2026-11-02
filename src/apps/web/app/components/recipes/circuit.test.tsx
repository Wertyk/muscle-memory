// @vitest-environment happy-dom
import type { JsonObject } from "@muscle-memory/recipe-engine";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";
import { CIRCUIT_MIN_WIDTH, recipeCircuit } from "@/lib/recipe-circuit";
import type { RecipeDraft } from "@/lib/recipe-studio";

import brokenPlatterDraft from "../../../server/fixtures/broken-platter-draft.json";
import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";
import { damagedItemBacktestFixture } from "../../../server/fixtures/backtest-recipes";
import { RecipeCircuit } from "./RecipeCircuit";
import { RecipeSteps } from "./RecipeSteps";

vi.mock("@/hooks/use-recipe-presentation", () => ({ useRecipePresentation: () => ({}) }));
vi.mock("@/components/shop/WorkspaceParts", () => ({ PendingMark: () => null }));
vi.mock("@agent-native/core/client/i18n", () => ({ useT: () => (key: string) => String(key.split(".")
  .reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], enUS) ?? key) }));

let root: Root;
let node: HTMLDivElement;
let width: number;
let height: number;
let scroll: number;
let callbacks: Map<number, FrameRequestCallback>;
let resize: () => void;
let observerCount: number;
let observerDisconnect: ReturnType<typeof vi.fn>;
let fontsReady: () => void;
let draft: RecipeDraft;
let loadKey: string;
const labels = { order: "Look up order", refund: "Issue refund", reply: "Send reply" };
const onChange = vi.fn(async () => {});
const rect = (left: number, top: number, width: number, height: number) =>
  ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect;
function bounds(this: Element): DOMRect {
  const top = 20 - scroll;
  const desired = Number.parseFloat(node.querySelector<HTMLElement>(".recipe-circuit")?.style.getPropertyValue("--circuit-gutter") ?? "110");
  const gutter = Math.min(desired, Math.max(110, width - 800));
  if (this.classList.contains("recipe-circuit")) return rect(40, top, width, height);
  if (this.classList.contains("recipe-circuit-sources")) return rect(40, top + 60, 200, height - 60);
  if (this.classList.contains("recipe-circuit-steps")) return rect(40 + 200 + gutter, top + 60, width - 200 - gutter, height - 60);
  if (this.hasAttribute("data-circuit-source-port")) {
    const index = [...node.querySelectorAll("[data-circuit-source-port]")].indexOf(this);
    return rect(40 + 200 - 3.5, top + 90 + index * 50 - 3.5, 7, 7);
  }
  if (this.hasAttribute("data-circuit-target-port")) {
    const disclosure = this.closest("details");
    if (disclosure && !disclosure.open) return rect(0, 0, 0, 0);
    const index = [...node.querySelectorAll("[data-circuit-target-port]")].indexOf(this);
    return rect(40 + 220 + gutter - 3.5, top + 200 + index * 50 - 3.5, 7, 7);
  }
  if (this.hasAttribute("data-circuit-formula")) {
    const pill = this as HTMLElement;
    const size = Math.min(68, 12 + (pill.textContent?.length ?? 0) * 6);
    return rect(40 + (Number.parseFloat(pill.style.left) || 0) - size / 2, top + (Number.parseFloat(pill.style.top) || 0) - 12, size, 24);
  }
  if (this.hasAttribute("data-formula-input") || this.hasAttribute("data-formula-output")) {
    const pill = this.parentElement!.getBoundingClientRect();
    return rect((this.hasAttribute("data-formula-input") ? pill.left : pill.right) - 3.5, pill.top + pill.height / 2 - 3.5, 7, 7);
  }
  return rect(0, 0, 0, 0);
}
async function frame() {
  await act(async () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(0));
  });
}
async function render(content = draft.content, disclosure = false) {
  draft = { ...draft, content };
  await act(async () => root.render(<RecipeCircuit {...{ draft, labels, loadKey }}>
    {disclosure ? <details open><summary>Steps</summary><RecipeSteps steps={content.steps ?? []} {...{ draft, labels, onChange }} disabled={false} /></details>
      : <RecipeSteps steps={content.steps ?? []} {...{ draft, labels, onChange }} disabled={false} />}
  </RecipeCircuit>));
  await frame(); // Width threshold, then DOM installation.
  await frame(); // Actual port measurement.
}
const chips = () => [...node.querySelectorAll(".recipe-wire")].map((chip) => chip.getAttribute("aria-label") ?? chip.textContent);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  width = 1125;
  height = 4000;
  scroll = 0;
  callbacks = new Map();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  observerCount = 0;
  observerDisconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; observerCount++; }
    observe() {}
    disconnect = observerDisconnect;
  });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => { fontsReady = resolve; }) } });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(bounds);
  draft = { recipeId: "recipe_circuit", revision: 0, baseVersionId: "ver_1", ambiguities: [], issues: [],
    content: { name: damagedItemFixture.name, trigger: damagedItemFixture.trigger, steps: damagedItemFixture.steps } as unknown as JsonObject };
  loadKey = "recipe_circuit:ver_1";
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

describe("Recipe Studio circuit DOM", () => {
  it("uses the 920px container breakpoint, fits the recording width, and preserves chip accessible text", async () => {
    expect(CIRCUIT_MIN_WIDTH).toBe(920);
    width = CIRCUIT_MIN_WIDTH - 1;
    await render();
    const narrowChips = chips();
    expect(node.querySelector(".recipe-circuit-wires")).toBeNull();
    expect(node.querySelector('[aria-label="Recipe sources"]')).toBeNull();
    expect(node.querySelector(".recipe-legend")).not.toBeNull();
    width = CIRCUIT_MIN_WIDTH;
    resize();
    await frame();
    await frame();
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("aria-hidden")).toBe("true");
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("focusable")).toBe("false");
    expect(node.querySelector('[aria-label="Recipe sources"]')).not.toBeNull();
    expect(node.querySelectorAll(".recipe-circuit-sources > section")).toHaveLength(3);
    expect(chips()).toEqual(narrowChips);
    expect(observerCount).toBe(1);
    expect(node.querySelectorAll("[data-circuit-target-port]")).toHaveLength(recipeCircuit(draft.content).targets.length);
    expect(node.querySelector(".recipe-circuit-formula")?.textContent).toContain("is");
    expect([...node.querySelectorAll(".recipe-circuit-formula")].some((pill) => pill.textContent === "× 0.5")).toBe(true);
    width = 965; // 1280px viewport with expanded nav and page insets.
    resize();
    await frame();
    expect(node.querySelector(".recipe-circuit-wires")).not.toBeNull();
    expect(node.querySelector(".recipe-circuit-steps")!.getBoundingClientRect().width).toBeGreaterThanOrEqual(600);
    width = 900;
    resize();
    await frame();
    expect(node.querySelector(".recipe-circuit-wires")).toBeNull();
    expect(node.querySelector(".recipe-circuit-sources")).toBeNull();
    expect(chips()).toEqual(narrowChips);
  });
  it("connects measured port centres, covers a long recipe and stays invariant when the whole container scrolls", async () => {
    await render();
    const path = node.querySelector<SVGPathElement>("[data-circuit-path]")!;
    const original = path.getAttribute("d");
    expect(original).toMatch(/^M 200 90 L /);
    expect(original).not.toContain(" C ");
    const trunk = [...node.querySelectorAll<SVGPathElement>("[data-circuit-path]")].filter((path) => path.dataset.circuitPath === "trunk:path:trigger.requestId");
    expect(trunk).toHaveLength(1);
    expect(node.querySelectorAll("[data-circuit-junction]")).toHaveLength(recipeCircuit(draft.content).edges.length);
    expect(node.querySelector("[data-circuit-junction]")?.getAttribute("r")).toBe("1.5");
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("viewBox")).toBeNull();
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("width")).toBe("1125");
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("height")).toBe("4000");
    scroll = 431.75;
    height = 6800;
    resize();
    resize();
    resize();
    expect(callbacks.size).toBe(1);
    await frame();
    expect(path.getAttribute("d")).toBe(original);
    expect(node.querySelector(".recipe-circuit-wires")?.getAttribute("height")).toBe("6800");
    await act(async () => fontsReady());
    expect(callbacks.size).toBe(1);
    await frame();
  });
  it("highlights connected rows and wires on hover/focus, pins on click, and clears on Escape or a second click", async () => {
    await render();
    const source = node.querySelector<HTMLButtonElement>(".recipe-circuit-source")!;
    await act(async () => source.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    expect(source.dataset.highlighted).toBe("true");
    expect(node.querySelector('.recipe-circuit-argument[data-highlighted="true"]')).not.toBeNull();
    expect(node.querySelector('.recipe-circuit-wire[data-highlighted="false"]')).not.toBeNull();
    await act(async () => source.click());
    expect(source.getAttribute("aria-pressed")).toBe("true");
    await act(async () => source.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
    expect(source.dataset.highlighted).toBe("true");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(node.querySelector(".recipe-circuit")?.getAttribute("data-circuit-active")).toBe("false");
    await act(async () => source.click());
    await act(async () => source.click());
    expect(node.querySelector(".recipe-circuit")?.getAttribute("data-circuit-active")).toBe("false");
    const edit = node.querySelector<HTMLButtonElement>(".recipe-circuit-argument button")!;
    await act(async () => edit.focus());
    expect(edit.closest("[data-circuit-node]")?.getAttribute("data-highlighted")).toBe("true");
    const model = recipeCircuit(draft.content);
    const selectedEdge = model.edges.find((edge) => edge.targetId === edit.closest<HTMLElement>("[data-circuit-node]")?.dataset.circuitNode)!;
    const paths = [...node.querySelectorAll<SVGPathElement>("[data-circuit-path]")];
    expect(paths.find((path) => path.dataset.circuitPath === `trunk:${selectedEdge.sourceId}`)?.dataset.highlighted).toBe("true");
    const sibling = model.edges.find((edge) => edge.sourceId === selectedEdge.sourceId && edge.targetId !== selectedEdge.targetId)!;
    expect(paths.find((path) => path.dataset.circuitPath === sibling.id)?.dataset.highlighted).toBe("false");
    await act(async () => edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(node.querySelector(".recipe-circuit")?.getAttribute("data-circuit-active")).toBe("false");
  });
  it("recomputes disclosures, observes only once, cleans up, and never replays entrance for edits or breakpoint changes", async () => {
    await render(draft.content, true);
    const disclosure = node.querySelector<HTMLDetailsElement>("details")!;
    const path = node.querySelector<SVGPathElement>("[data-circuit-path]")!;
    expect(path.hasAttribute("data-enter")).toBe(true);
    await act(async () => { disclosure.open = false; });
    await frame();
    expect(path.hasAttribute("d")).toBe(false);
    await act(async () => { disclosure.open = true; });
    await frame();
    expect(path.hasAttribute("d")).toBe(true);
    const changed = structuredClone(draft.content);
    const steps = changed.steps as unknown as { args: Record<string, unknown> }[];
    steps[0]!.args.extra = { mode: "path", path: "trigger.newField" };
    await render(changed, true);
    const added = [...node.querySelectorAll<SVGPathElement>("[data-circuit-path]")].find((path) => path.dataset.circuitPath?.includes("newField"))!;
    expect(added.hasAttribute("data-enter")).toBe(false);
    expect(added.hasAttribute("d")).toBe(true);
    width = 900;
    resize();
    await frame();
    width = 1400;
    resize();
    await frame();
    await frame();
    expect(node.querySelector("[data-enter]")).toBeNull();
    loadKey = "recipe_circuit:ver_2";
    await render(changed, true);
    expect(node.querySelector("[data-enter]")).not.toBeNull();
    expect(observerCount).toBe(1);
    await act(async () => root.unmount());
    expect(observerDisconnect).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
    root = createRoot(node);
  });
  it("renders Teach-derived and agent-run content with template fan-in and no extra reads", async () => {
    await render({ name: brokenPlatterDraft.name, trigger: brokenPlatterDraft.trigger, steps: brokenPlatterDraft.steps } as JsonObject);
    expect(node.querySelectorAll("[data-circuit-path]").length).toBeGreaterThan(0);
    expect(node.querySelectorAll("[data-circuit-target-port]")).toHaveLength(recipeCircuit(draft.content).targets.length);
    const agentRecipe: JsonObject = { steps: [{ id: "reply", kind: "action", action: "send-reply", args: {
      template: { mode: "template", template: "Hi {{trigger.customerName}}, order {{trigger.orderId}}: {{steps.shipment.output.status}}." },
    } }] };
    await render(agentRecipe);
    expect(node.querySelectorAll("[data-circuit-path]")).toHaveLength(6);
    expect(node.querySelectorAll(".recipe-inline-wire")).toHaveLength(3);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("groups compact output fields by producer and never exposes raw constant template syntax", async () => {
    await render({ name: damagedItemBacktestFixture.name, trigger: damagedItemBacktestFixture.trigger, steps: damagedItemBacktestFixture.steps } as unknown as JsonObject);
    const rail = node.querySelector<HTMLElement>(".recipe-circuit-sources")!;
    expect(rail.textContent).not.toContain("{{");
    expect(rail.textContent).not.toContain("→");
    expect(rail.textContent).toContain("01 Look up order");
    expect(rail.textContent).toContain("First item · unit price · currency");
    expect(rail.textContent).toContain("Message template · 2 variables");
    const request = [...rail.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.dataset.circuitNode === "path:trigger.orderId")!;
    expect(request.textContent).toBe("Order ID");
    expect(request.getAttribute("aria-label")).toBe("Request · Order ID");
    for (const element of rail.querySelectorAll("[aria-label], [title]")) {
      expect(element.getAttribute("aria-label") ?? element.getAttribute("title")).not.toContain("{{");
    }
    const model = recipeCircuit(draft.content, labels);
    expect([...node.querySelectorAll<SVGPathElement>("[data-circuit-path]")].filter((path) => path.dataset.circuitPath?.startsWith("trunk:")))
      .toHaveLength(model.sources.length);
    expect([...node.querySelectorAll("[data-circuit-junction]")].every((dot) => dot.getAttribute("cx") !== null)).toBe(true);
    const formulas = [...node.querySelectorAll<HTMLElement>("[data-circuit-formula]")];
    for (const pill of formulas) {
      expect(pill.getBoundingClientRect().right).toBe(node.querySelector(".recipe-circuit-steps")!.getBoundingClientRect().left - 4);
    }
    const bounds = node.querySelector(".recipe-circuit")!.getBoundingClientRect();
    const firstPillInput = Math.min(...[...node.querySelectorAll("[data-formula-input]")].map((port) => port.getBoundingClientRect().left + 3.5 - bounds.left));
    for (const junction of node.querySelectorAll("[data-circuit-junction]")) {
      expect(Number(junction.getAttribute("cx"))).toBeLessThanOrEqual(firstPillInput - 8);
    }
  });
  it("keeps an open money editor mounted across sidebar/container breakpoint changes", async () => {
    await render();
    const currency = [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Edit Currency")!;
    await act(async () => currency.click());
    const textarea = node.querySelector("form textarea");
    expect(textarea).not.toBeNull();
    width = 900;
    resize();
    await frame();
    expect(node.querySelector("form textarea")).toBe(textarea);
    width = 1300;
    resize();
    await frame();
    await frame();
    expect(node.querySelector("form textarea")).toBe(textarea);
  });
});
