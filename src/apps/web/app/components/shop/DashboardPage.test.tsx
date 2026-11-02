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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
  it("plots log-scale handler evidence, switches units, and exposes the method and split records", async () => {
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
    const time = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Active time",
    )!;
    await act(async () => time.click());
    expect(time.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
    ).toContain("Active time");
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
    expect(agent.textContent).toContain("530K tokens · 47.4 s");
    expect(agent.textContent).toContain("n = 1");
    expect(recipe.textContent).toContain("436 tokens");
    expect(recipe.textContent).toContain("n = 6");
    expect(recipe.textContent).toContain(
      "All intake extraction · recipe steps 0 tokens",
    );
    expect(
      container.querySelector('[data-request-id="req_5"] title')?.textContent,
    ).toContain("Intake extraction 1,307 tokens · recipe steps 0 tokens");
    expect(container.textContent).not.toContain("latest 5");
  });
  it("shows separate token and time counts only when their measured cohorts differ", async () => {
    const samples = [sample(1, 100), { ...sample(2, 200), durationMs: null }];
    await render(await data(samples));
    expect(
      container.querySelector(
        '.dashboard-handler-cost[data-handler="agent"] .dashboard-sample-count',
      )?.textContent,
    ).toBe("Tokens n = 2 · time n = 1");
  });

  it.each([1280, 1440, 1920])(
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
        const glyphBound = (label.textContent?.length ?? 0) * 15;
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
    const recordLink = container.querySelector('a[href="/requests/req_70"]')!;
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
