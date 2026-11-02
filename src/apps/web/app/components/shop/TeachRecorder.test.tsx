// @vitest-environment happy-dom
import type { Demonstration, DemonstrationStep } from "@muscle-memory/recipe-engine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";

import { createShopDemoData } from "../../../server/db/shop-demo-data";
import { ShopActionResult } from "./ShopActionResult";
import { TeachBar } from "./TeachBar";
import { TeachFilmstrip } from "./TeachFilmstrip";
import { actionIcon, elapsedTime, stepArgument } from "./teach-recorder";

vi.mock("@agent-native/core/client/i18n", () => ({
  useT: () => (key: string, values: Record<string, unknown> = {}) => {
    const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], enUS);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""));
  },
}));
vi.mock("@agent-native/toolkit/app/chat", () => ({ AgentToggleButton: () => null }));
vi.mock("@agent-native/core/client/hooks", () => ({
  actionErrorMessage: (cause: unknown) => String(cause),
  useDbSync: () => {},
  useActionQuery: () => ({ data: trace, isPending: false, isError: false, refetch: async () => ({ data: trace }) }),
  useActionMutation: (name: string) => ({ mutateAsync: async () => {
    mutations.push(name);
    if (name === "stop-demonstration") trace = { ...trace, status: "completed", stoppedAt: start + 72_000 };
    return trace;
  } }),
}));

const start = Date.parse("2026-11-02T10:00:00Z");
const request = createShopDemoData(new Date(start).toISOString()).requests[0]!;
function step(sequence: number, action: string, input: DemonstrationStep["input"], seconds: number): DemonstrationStep {
  return { id: `step_${sequence}`, sequence, action, input, output: {}, startedAt: start + seconds * 1000, durationMs: 10, caller: "frontend", navigation: null };
}
function fixture(): Demonstration {
  return {
    id: "demo_recorder", subjectId: request.id, references: {}, trigger: { type: "damaged_item" },
    scope: { userId: "operator", workspaceId: "shop", sessionId: "tab" },
    status: "recording", startedAt: start, stoppedAt: null, incompleteReason: null, nextSequence: 9, pending: [],
    steps: [
      step(1, "get-request", { requestId: "req_0001" }, 0),
      step(2, "get-order", { orderId: "ord_1042" }, 1),
      step(3, "get-customer", { customerId: "cus_0001" }, 2),
      step(4, "get-shipment-status", { orderId: "ord_1042" }, 3),
      step(5, "get-request-activity", { requestId: "req_0001" }, 4),
      step(6, "issue-refund", { orderId: "ord_1042", amount: { amountMinor: 14000, currency: "USD" } }, 14),
      { ...step(7, "send-reply", { requestId: "req_0001", body: "Hi Maya" }, 40), output: { body: "Hi Maya, your $140.00 refund is saved." } },
      step(8, "tag-request", { requestId: "req_0001", tag: "damaged" }, 61),
    ],
  };
}
let trace: Demonstration;
let mutations: string[];
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let motionAllowed: boolean;
const motionListeners = new Set<() => void>();
async function render(children: React.ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>));
}
async function clickButton(name: string) {
  const button = [...container.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name);
  expect(button, name).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  trace = fixture();
  mutations = [];
  motionAllowed = true;
  motionListeners.clear();
  vi.spyOn(Date, "now").mockReturnValue(start + 72_000);
  vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
    media, get matches() { return motionAllowed; }, onchange: null,
    addEventListener: (_event: string, listener: () => void) => { motionListeners.add(listener); },
    removeEventListener: (_event: string, listener: () => void) => { motionListeners.delete(listener); },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  }) as unknown as MediaQueryList);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});

describe("Teach recorder", () => {
  it.each([
    [0, "0:00"], [14_999, "0:14"], [72_000, "1:12"], [3_661_000, "61:01"], [-1000, "0:00"],
  ])("formats elapsed milliseconds %i from a persisted start", (offset, expected) => {
    expect(elapsedTime(start, start + offset)).toBe(expected);
  });

  it.each([
    ["issue-refund", "receipt"], ["send-reply", "message"], ["tag-request", "tag"],
    ["create-replacement-order", "package"], ["update-shipping-address", "pin"], ["set-request-status", "bolt"],
  ])("maps %s to its action icon", (action, expected) => {
    expect(actionIcon(action)).toBe(expected);
  });

  it("summarizes captured values without inventing results", () => {
    expect(stepArgument(trace.steps[5]!)).toBe("$140.00 · ord_1042");
    expect(stepArgument(trace.steps[6]!)).toBe("Hi Maya, your $140.00 refund is saved.");
    expect(stepArgument(trace.steps[7]!)).toBe("damaged");
    expect(stepArgument(step(9, "get-order", { orderId: "ord_1042" }, 0))).toBe("ord_1042");
    expect(stepArgument(step(10, "update-shipping-address", { address: { line1: "14 Studio Lane", city: "Alder Glen" } }, 0))).toBe("14 Studio Lane, Alder Glen");
    expect(stepArgument({ ...step(11, "create-replacement-order", {}, 0), output: { items: [{ quantity: 2, name: "Chalk Mug" }] } })).toBe("2 × Chalk Mug");
  });

  it("renders numbered action tiles and chronological lookup ticks from the trace", async () => {
    await render(<TeachFilmstrip demo={trace} motion />);
    const tiles = [...container.querySelectorAll<HTMLElement>(".shop-teach-strip li")];
    expect(tiles).toHaveLength(3);
    expect(tiles.map((tile) => tile.dataset.action)).toEqual(["issue-refund", "send-reply", "tag-request"]);
    expect(tiles.map((tile) => tile.style.order)).toEqual(["6", "7", "8"]);
    expect([...container.querySelectorAll(".shop-teach-step-number")].map((node) => node.textContent)).toEqual(["1", "2", "3"]);
    expect([...container.querySelectorAll(".shop-teach-offset")].map((node) => node.textContent)).toEqual(["+0:14", "+0:40", "+1:01"]);
    expect(tiles[0]?.querySelector(".shop-teach-step-args")?.getAttribute("title")).toBe("$140.00 · ord_1042");
    expect(tiles.every((tile) => tile.querySelector("svg") && tile.classList.contains("shop-teach-snap"))).toBe(true);
    const ticks = [...container.querySelectorAll<HTMLElement>(".shop-teach-lookup")];
    expect(ticks).toHaveLength(5);
    expect(ticks.map((tick) => tick.style.order)).toEqual(["1", "2", "3", "4", "5"]);
    expect(ticks[3]?.getAttribute("aria-label")).toBe("Shipment · ord_1042 · +0:03");
  });

  it("shows persisted elapsed time on reload and reports recording state to the workspace", async () => {
    const onRecordingChange = vi.fn();
    await render(<TeachBar request={request} onRecordingChange={onRecordingChange} />);
    expect(container.querySelector(".shop-teach-elapsed")?.textContent).toBe("1:12");
    expect(container.querySelector(".shop-teach-scope")?.textContent).toContain("Teaching req_0001");
    expect(container.querySelector(".shop-teach-count")?.textContent).toBe("3 actions · 5 lookups");
    expect(onRecordingChange).toHaveBeenLastCalledWith(true);
    await render(null);
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
    await render(<TeachBar request={request} />);
    expect(container.querySelector(".shop-teach-elapsed")?.textContent).toBe("1:12");
  });

  it("scrolls the filmstrip to the newest capture without animating the scroll", async () => {
    await render(<TeachFilmstrip demo={trace} />);
    const timeline = container.querySelector<HTMLElement>(".shop-teach-timeline")!;
    Object.defineProperty(timeline, "scrollWidth", { value: 900 });
    timeline.scrollLeft = 0;
    await render(<TeachFilmstrip demo={{ ...trace, steps: [...trace.steps, step(9, "tag-request", { tag: "reviewed" }, 70)] }} />);
    expect(timeline.scrollLeft).toBe(900);
  });

  it("condenses a saved trace into icons, counts, duration and Create recipe draft", async () => {
    trace = { ...trace, status: "completed", stoppedAt: start + 72_000 };
    await render(<TeachBar request={request} />);
    expect(container.textContent).toContain("Demonstration saved");
    expect(container.textContent).toContain("3 actions · 5 lookups · 1:12");
    expect(container.querySelectorAll('.shop-teach-mini [aria-label="Captured actions"] li')).toHaveLength(3);
    expect(container.querySelector(".shop-teach-timeline")).toBeNull();
    expect(container.querySelector(".shop-teach-inspect summary")?.textContent).toBe("Inspect captured trace");
    const draft = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Create recipe draft");
    expect(draft?.disabled).toBe(false);
    await clickButton("Discard recording");
    expect(container.querySelector(".shop-teach-bar")?.getAttribute("data-state")).toBe("ready");
    expect(mutations).toEqual([]); // Dismissal does not pretend to delete an immutable trace.
  });

  it("animates measured tiles into the saved card only when motion is allowed", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation));
    vi.spyOn(Element.prototype, "animate").mockImplementation(animate);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.closest(".shop-teach-mini")) return new DOMRect(30, 30, 30, 30);
      if (this.classList.contains("shop-teach-tile")) return new DOMRect(100, 100, 200, 100);
      return new DOMRect(0, 0, 800, 240);
    });
    await render(<TeachBar request={request} />);
    await clickButton("Stop & save");
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate.mock.calls[0]).toEqual([
      [{ transform: "none", opacity: 1 }, { transform: "translate(-70px, -70px) scale(0.15, 0.3)", opacity: 0 }],
      { duration: 400, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    ]);
    expect(container.querySelector(".shop-teach-flight-layer")).toBeNull();
    expect(container.textContent).toContain("Demonstration saved");
  });

  it("removes animated classes when reduced motion changes and swaps directly on stop", async () => {
    const animate = vi.fn();
    vi.spyOn(Element.prototype, "animate").mockImplementation(animate);
    await render(<TeachBar request={request} />);
    expect(container.querySelector(".shop-teach-pulse")).not.toBeNull();
    await act(async () => {
      motionAllowed = false;
      motionListeners.forEach((listener) => listener());
    });
    expect(container.querySelector(".shop-teach-bar")?.getAttribute("data-motion")).toBe("reduced");
    expect(container.querySelector(".shop-teach-pulse, .shop-teach-snap")).toBeNull();
    await clickButton("Stop & save");
    expect(animate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Demonstration saved");
  });

  it("shows a compact single-line success status with full detail and dismiss", async () => {
    const onDismiss = vi.fn();
    const result = { title: "Tag added", detail: "req_0001" };
    await render(<ShopActionResult result={result} onDismiss={onDismiss} />);
    expect(container.querySelector<HTMLElement>(".shop-action-result-slot")?.hidden).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Tag added · req_0001");
    expect(container.querySelectorAll(".shop-action-result p")).toHaveLength(1);
    expect(container.querySelector(".shop-action-result p")?.getAttribute("title")).toBe("Tag added · req_0001");
    await clickButton("Close");
    expect(onDismiss).toHaveBeenCalledOnce();
    await render(<ShopActionResult result={null} onDismiss={onDismiss} />);
    expect(container.querySelector<HTMLElement>(".shop-action-result-slot")?.hidden).toBe(true);
    expect(container.querySelector(".shop-saved-result")).toBeNull();
  });
});
