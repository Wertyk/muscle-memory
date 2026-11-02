// @vitest-environment happy-dom
import {
  GetHandlingStats,
  type HandlingSample,
  type HandlingStats,
} from "@muscle-memory/shop-domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";

import { COST_PLOT } from "./dashboard-scale";
import { DashboardPage } from "./DashboardPage";

const state = vi.hoisted(() => ({ query: vi.fn(), retry: vi.fn() }));
vi.mock("@agent-native/core/client/hooks", () => ({
  useActionQuery: state.query,
  actionErrorMessage: () => "Offline",
}));
vi.mock("@agent-native/toolkit/app/chat", () => ({
  AgentToggleButton: () => <button>Agent sidebar</button>,
}));
vi.mock("@agent-native/core/client/i18n", () => ({
  useT:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enUS,
        );
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(values[name] ?? ""),
      );
    },
}));

let root: Root;
let container: HTMLDivElement;
const sample = (n: number, tokens: number | null): HandlingSample => ({
  recipe: n <= 5 ? null : { name: "Damaged item", version: 1 },
  requestId: `req_${n}`,
  completedAt: Date.UTC(2026, 10, 2, 12, n),
  requestType: "damaged_item",
  tokens,
  agentTokens: n <= 5 ? tokens : null,
  intakeTokens: n <= 5 ? 0 : tokens,
  runTokens: tokens === null ? null : 0,
  durationMs: tokens === null ? null : tokens + 1,
  handler: n <= 5 ? "agent" : "recipe",
});
async function data(samples: HandlingSample[] = []) {
  return new GetHandlingStats({
    read: async () => ({ samples, pendingApprovals: 1, activeRecipes: 2 }),
  }).execute();
}
async function render(value?: HandlingStats, props = {}) {
  state.query.mockReturnValue({
    data: value,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: state.retry,
    ...props,
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
  });
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Dashboard measured views", () => {
  it("renders loading, read failure with retry, and an honest empty cohort", async () => {
    await render(undefined, { isPending: true });
    expect(
      container.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Loading handling measurements");
    await render(undefined, { isError: true, error: new Error("Offline") });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () =>
      (
        container.querySelector('[role="alert"] button') as HTMLButtonElement
      ).click(),
    );
    expect(state.retry).toHaveBeenCalledOnce();
    await render(await data());
    expect(container.textContent).toContain("The curve starts with real work.");
    expect(container.textContent).toContain("Not enough data");
    expect(container.querySelectorAll(".dashboard-no-samples")).toHaveLength(
      10,
    );
    expect(
      container.querySelectorAll(".dashboard-comparison tbody tr"),
    ).toHaveLength(5);
    expect(container.querySelector("svg[role=img]")).toBeNull();
    expect(
      state.query.mock.calls[state.query.mock.calls.length - 1]?.slice(0, 2),
    ).toEqual(["get-handling-stats", {}]);
  });
  it("aligns log-scale token evidence with running zero share and exposes the method and split records", async () => {
    const samples = Array.from({ length: 12 }, (_, n) =>
      sample(n + 1, n < 5 ? 1000 : 0),
    );
    await render(await data(samples));
    expect(
      container.querySelectorAll('.dashboard-point[data-handler="agent"]'),
    ).toHaveLength(5);
    expect(
      container.querySelectorAll('.dashboard-point[data-handler="recipe"]'),
    ).toHaveLength(7);
    expect(container.querySelector(".dashboard-average")).toBeNull();
    expect(container.querySelectorAll('[data-lane="zero"]')).toHaveLength(7);
    expect(container.querySelector(".dashboard-zero-lane")?.textContent).toBe(
      "0 tokens",
    );
    expect(container.textContent).toContain("1,000 tokens");
    expect(container.textContent).toContain("0 tokens");
    expect(container.querySelectorAll(".dashboard-memory svg")).toHaveLength(2);
    expect(container.querySelectorAll(".dashboard-share-point")).toHaveLength(12);
    expect(container.querySelector(".dashboard-share-label")?.textContent).toBe("58.3%");
    const first = container.querySelector(".dashboard-point .dashboard-hit")!;
    const share = container.querySelector(".dashboard-share-point")!;
    expect(first.getAttribute("cx")).toBe(share.getAttribute("cx"));
    expect(
      container.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
    ).toContain("Running share of zero-token handling");
    expect(container.textContent).toContain("agent_trace_summaries");
    expect(container.querySelector('a[href="/requests/req_1"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="/inbox?processing=awaiting_approval"]'),
    ).not.toBeNull();
    expect(container.querySelector('a[href="/inbox"]')).toBeNull(); // shared masthead, no duplicate navigation shell
  });
  it("never plots unknown cost as zero and shows sample counts without noisy empty sub-lines", async () => {
    const samples = [sample(1, 100), sample(2, null), sample(6, 0)];
    await render(await data(samples), {
      isError: true,
      error: new Error("Offline"),
    });
    expect(container.querySelectorAll(".dashboard-point")).toHaveLength(2);
    expect(container.querySelectorAll('[data-lane="zero"]')).toHaveLength(1);
    expect(container.querySelectorAll(".dashboard-average")).toHaveLength(0);
    expect(container.textContent).toContain("1 outcomes have unknown tokens");
    expect(container.textContent).toContain("Unmeasured");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      container.querySelectorAll(".dashboard-sample-count")[0]?.textContent,
    ).toContain("n = 1");
  });
  it("headlines all measured outcomes with whole-token means and explicit intake versus recipe steps", async () => {
    const samples: HandlingSample[] = [0, 0, 0, 0, 1307, 1308].map(
      (tokens, n) => ({
        ...sample(n + 1, tokens),
        handler: "recipe" as const,
        agentTokens: null,
        intakeTokens: tokens,
        runTokens: 0,
      }),
    );
    samples.push({
      ...sample(7, 530197),
      handler: "agent",
      agentTokens: 530197,
      intakeTokens: 0,
      runTokens: 0,
    });
    samples[6] = { ...samples[6]!, durationMs: 47448 };
    await render(await data(samples));
    const agent = container.querySelector(
      '.dashboard-handler-cost[data-handler="agent"]',
    )!;
    const recipe = container.querySelector(
      '.dashboard-handler-cost[data-handler="recipe"]',
    )!;
    expect(agent.querySelector(".dashboard-hero-tokens .sr-only")?.textContent).toBe("530K tokens");
    expect(agent.querySelector(".dashboard-hero-time .sr-only")?.textContent).toBe("47.4 s");
    expect(agent.textContent).toContain("n = 1");
    expect(recipe.textContent).toContain("436 tokens");
    expect(recipe.textContent).toContain("n = 6");
    expect(recipe.textContent).toContain(
      "Intake extraction 436 tokens · recipe steps 0 tokens",
    );
    expect(
      container.querySelector('[data-request-id="req_5"] title')?.textContent,
    ).toContain("Intake extraction 1,307 tokens · recipe steps 0 tokens");
    expect(container.textContent).not.toContain("latest 5");
  });
  it("shows separate token and time counts only when their measured cohorts differ", async () => {
    const samples = [sample(1, 100), { ...sample(2, 200), durationMs: null }, sample(6, 0)];
    await render(await data(samples));
    expect(
      container.querySelector(
        '.dashboard-handler-cost[data-handler="agent"] .dashboard-sample-count',
      )?.textContent,
    ).toBe("Tokens n = 2 · time n = 1");
    expect(container.querySelector(".dashboard-ratio-qualifier")?.textContent).toBe("agent Tokens n = 2 · time n = 1 vs recipe n = 1 · different requests");
  });

  it("shows final hero values immediately under reduced motion, with no scheduled count-up", async () => {
    const frame = vi.spyOn(globalThis, "requestAnimationFrame");
    await render(await data([{ ...sample(1, 95_000), durationMs: 7500 }, ...[6, 7, 8].map(n => ({ ...sample(n, 0), durationMs: 17 }))]));
    const hero = container.querySelector(".dashboard-hero")!;
    expect([...hero.querySelectorAll('[data-measurement] > [aria-hidden="true"]')].map(node => node.textContent)).toEqual(["95K tokens", "7.5 s", "0 tokens", "17 ms"]);
    expect([...hero.querySelectorAll(".sr-only")].map(node => node.textContent)).toEqual(["95K tokens", "7.5 s", "0 tokens", "17 ms"]);
    expect(frame).not.toHaveBeenCalled();
    expect(hero.textContent).toContain("441× faster");
    expect(hero.querySelector(".dashboard-ratio-qualifier")?.textContent).toBe("agent n = 1 vs recipe n = 3 · different requests");
    expect(hero.textContent).toContain("95K tokens avoided per request");
    expect(hero.textContent).not.toMatch(/∞|Infinity|NaN/);
  });

  it("counts up once using Kiln motion tokens while accessible values remain final, then updates without replay", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const measured = await data([{ ...sample(1, 95_000), durationMs: 7500 }]);
    await render(measured);
    const token = () => container.querySelector('.dashboard-hero-tokens [aria-hidden="true"]')?.textContent;
    const accessible = () => container.querySelector(".dashboard-hero-tokens .sr-only")?.textContent;
    expect(token()).toBe("0 tokens");
    expect(accessible()).toBe("95K tokens");
    await act(async () => frames.shift()!(0));
    await act(async () => frames.shift()!(360));
    expect(token()).not.toBe("0 tokens");
    expect(accessible()).toBe("95K tokens");
    await act(async () => frames.shift()!(720));
    expect(token()).toBe("95K tokens");
    expect(frames).toHaveLength(0);
    await render(await data([{ ...sample(1, 96_000), durationMs: 7600 }]));
    expect(token()).toBe("96K tokens");
    expect(frames).toHaveLength(0);
  });

  it("offers focusable points with full saved measurements and the same rows in View as table", async () => {
    await render(await data([sample(1, 100), sample(6, 0)]));
    const dot = container.querySelector('.dashboard-point[data-request-id="req_6"]') as SVGAElement;
    expect(dot.getAttribute("aria-label")).toContain("req_6 · Recipe · Damaged item v1 · 0 tokens · 1 ms");
    expect(Number(dot.querySelector(".dashboard-hit")?.getAttribute("r"))).toBeGreaterThan(Number(dot.querySelector(".dashboard-mark")?.getAttribute("r")));
    await act(async () => dot.focus());
    expect(document.activeElement).toBe(dot);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Damaged item v1");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("0 tokens · 1 ms");
    const records = [...container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent?.includes("View as table"))!;
    expect(records.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(records.querySelector(".kiln-maker")?.getAttribute("aria-label")).toContain("Damaged item v1, 0 LLM tokens");
    expect(records.querySelector('a[href="/requests/req_6"]')?.closest("tr")?.textContent).toContain("Intake extraction 0 tokens · recipe steps 0 tokens");
  });

  it.each([["right", 1440], ["top", 1440], ["top-right", 1440], ["top-right", 390]] as const)("keeps a tooltip inside the chart card at the %s edge at %ipx", async (edge, viewportWidth) => {
    const card = viewportWidth === 390 ? new DOMRect(20, 100, 350, 650) : new DOMRect(300, 100, 1000, 650);
    const point = new DOMRect(edge.includes("right") ? card.right - 30 : card.left + card.width / 2, edge.includes("top") ? 110 : 390, 20, 20);
    const bounds = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches(".dashboard-chart-panel")) return card;
      if (this.matches(".dashboard-point")) return point;
      if (this.hasAttribute("data-radix-popper-content-wrapper")) return new DOMRect(0, 0, 300, 100);
      if (this === document.documentElement) return new DOMRect(0, 0, viewportWidth, 900);
      return bounds.call(this);
    });
    for (const [dimension, viewport, cardValue, tooltipValue] of [["Width", viewportWidth, card.width, 300], ["Height", 900, 650, 100]] as const) {
      vi.spyOn(HTMLElement.prototype, `client${dimension}`, "get").mockImplementation(function (this: HTMLElement) {
        return this.matches(".dashboard-chart-panel") ? cardValue : viewport;
      });
      vi.spyOn(HTMLElement.prototype, `offset${dimension}`, "get").mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-radix-popper-content-wrapper") ? tooltipValue : this.matches(".dashboard-chart-panel") ? cardValue : viewport;
      });
    }
    await render(await data([sample(1, 95_000)]));
    await act(async () => {
      (container.querySelector(".dashboard-point") as SVGAElement).focus();
      await vi.waitFor(() => {
        const wrapper = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')!;
        expect(wrapper?.style.transform).toMatch(/translate\([\d.]+px, [\d.]+px\)/);
      });
    });
    const wrapper = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')!;
    const [, x, y] = wrapper.style.transform.match(/translate\(([\d.]+)px, ([\d.]+)px\)/)!;
    expect(Number(x)).toBeGreaterThanOrEqual(card.left + 12);
    expect(Number(x) + 300).toBeLessThanOrEqual(card.right - 12);
    expect(Number(y)).toBeGreaterThanOrEqual(card.top + 12);
    expect(Number(y) + 100).toBeLessThanOrEqual(card.bottom - 12);
    const content = document.querySelector<HTMLElement>(".dashboard-tooltip")!;
    expect(content.dataset.side).toBe(edge.includes("top") ? "bottom" : "top");
  });

  it.each([390, 1280, 1440, 1920])(
    "keeps compact axis labels inside the SVG at viewport width %i",
    async (viewport) => {
      await render(
        await data([sample(1, 530197), sample(6, 1308), sample(7, 0)]),
      );
      const svg = container.querySelector(".dashboard-curve svg")!;
      expect(svg.textContent).toContain("1M");
      expect(svg.textContent).not.toContain("530,197");
      // All SVG geometry, including text, scales together. Even a conservative
      // one-em-per-character label bound fits inside its reserved gutter.
      const renderedWidth = Math.max(608, Math.min(viewport - 320, 1184) - 64);
      const factor = renderedWidth / COST_PLOT.width;
      for (const label of svg.querySelectorAll(
        ".dashboard-axis-tick text, .dashboard-zero-lane text",
      )) {
        const x = Number(label.getAttribute("x"));
        const glyphBound = (label.textContent?.length ?? 0) * (viewport === 390 ? 20 : 15);
        expect((x - glyphBound) * factor).toBeGreaterThanOrEqual(0);
      }
    },
  );
  it("shows agent-turn tokens in the chart title and Inspect record, and the optional recipe intake-only note", async () => {
    const measured = {
      ...sample(70, 530197),
      handler: "agent" as const,
      agentTokens: 530197,
      intakeTokens: 0,
      runTokens: 0,
    };
    await render(
      await data([
        measured,
        {
          ...sample(71, 1308),
          handler: "recipe",
          agentTokens: null,
          intakeTokens: 1308,
          runTokens: 0,
        },
      ]),
    );
    const breakdown = "Agent turns 530K · intake extraction 0 · recipe steps 0";
    expect(
      container.querySelector('[data-request-id="req_70"] title')?.textContent,
    ).toContain(breakdown);
    const recordLink = container.querySelector('table a[href="/requests/req_70"]')!;
    expect(
      recordLink.closest("tr")?.querySelector(".dashboard-record-breakdown")
        ?.textContent,
    ).toBe(breakdown);
    expect(
      container.querySelector(".dashboard-comparison tbody tr")?.textContent,
    ).toContain("All intake extraction · recipe steps 0 tokens");
    await render(
      await data([{ ...measured, agentTokens: null, tokens: null }]),
    );
    expect(
      container.querySelector(".dashboard-record-breakdown")?.textContent,
    ).toContain("Agent turns Unmeasured");
  });
});
