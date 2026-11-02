// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@muscle-memory/recipe-engine";
import type { RequestProcessing } from "@shared/request-processing";
import { runFixtures } from "../../../server/fixtures/run-recipes";
import { RunSignature } from "./RunSignature";
import { AgentCostTag } from "./AgentCostTag";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@agent-native/core/client/hooks", () => ({ useActionQuery: read }));
const run: Run = {
  id: "run_1", recipe: runFixtures.completed, trigger: { requestId: "req_1" }, mode: "execute", status: "completed",
  steps: [], pendingStepIds: [], approvedStepIds: [], awaitingApprovalStepId: null, tokens: { input: 0, output: 0 },
  failure: null, handoff: null, createdAt: 1, updatedAt: 2,
};
const row: RequestProcessing = {
  requestId: "req_1", runId: "run_1", state: "auto_handled", matchReason: "matched", tokens: { input: 12, output: 8 },
  recipe: { name: run.recipe.name, version: run.recipe.version }, runStatus: "completed", mode: "execute", totalTokens: 20, durationMs: 17,
};
beforeEach(() => read.mockReset());

describe("saved run signatures", () => {
  it("shows intake + execution measurements, never a zero execution-only stamp", () => {
    read.mockReturnValue({ data: [row], isSuccess: true });
    const html = renderToStaticMarkup(<RunSignature run={run} size="large" />);
    expect(html).toContain("20 LLM tokens");
    expect(html).toContain("20 tokens · 17 ms");
    expect(html).toContain("(incl. intake)");
    expect(html).toContain("V1 · 20 TOKENS");
    expect(html).not.toContain("V1 · 0 TOKENS");
    expect(read).toHaveBeenCalledWith("list-request-processing", { requestIds: ["req_1"] }, { enabled: true });
  });
  it("names the completed recipe beside a compact banner stamp", () => {
    read.mockReturnValue({ data: [row], isSuccess: true });
    const html = renderToStaticMarkup(<RunSignature run={run} size="compact" showRecipe />);
    expect(html).toContain(`Handled by ${run.recipe.name} · v${run.recipe.version}`);
    expect(html).toContain('data-size="compact"');
    expect(renderToStaticMarkup(<RunSignature run={{ ...run, mode: "dry-run" }} showRecipe />)).not.toContain("Handled by");
  });
  it("uses execution data for a standalone run, and never borrows a different run's intake", () => {
    read.mockReturnValue({ data: [{ ...row, runId: "run_other" }], isSuccess: true });
    expect(renderToStaticMarkup(<RunSignature run={run} />)).toContain("0 tokens · 0 ms");
    read.mockReturnValue({});
    expect(renderToStaticMarkup(<RunSignature run={{ ...run, trigger: {} }} />)).toContain("0 tokens · 0 ms");
  });
  it("does not invent costs while linked intake is loading or unavailable", () => {
    read.mockReturnValue({ isSuccess: false });
    expect(renderToStaticMarkup(<RunSignature run={run} />)).toContain("Tokens unmeasured");
    read.mockReturnValue({ data: [row], isSuccess: true, isError: true });
    expect(renderToStaticMarkup(<RunSignature run={run} />)).toContain("Tokens unmeasured");
  });
});

describe("attributed agent costs", () => {
  it("uses only the same request's agent measurement from the shared stats action", () => {
    read.mockReturnValue({ data: { samples: [{ requestId: "req_other", handler: "agent", tokens: 10, durationMs: 20 }, { requestId: "req_1", handler: "agent", tokens: 95_000, durationMs: 7500 }] } });
    const html = renderToStaticMarkup(<AgentCostTag requestId="req_1" />);
    expect(html).toContain("95K tokens · 7.5 s");
    expect(html).toContain('data-handler="agent"');
    expect(read).toHaveBeenCalledWith("get-handling-stats", {});
  });
  it("never labels queued work, a recipe measurement or failed attribution as zero agent tokens", () => {
    read.mockReturnValue({ data: { samples: [{ requestId: "req_1", handler: "recipe", tokens: 0 }] } });
    expect(renderToStaticMarkup(<AgentCostTag requestId="req_1" />)).toBe("");
    expect(renderToStaticMarkup(<AgentCostTag requestId="req_1" showUnknown />)).toContain("Tokens unmeasured");
    read.mockReturnValue({ data: { samples: [{ requestId: "req_1", handler: "agent", tokens: 95_000 }] }, isError: true });
    expect(renderToStaticMarkup(<AgentCostTag requestId="req_1" />)).toBe("");
  });
});
