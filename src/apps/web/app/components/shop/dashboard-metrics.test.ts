import { GetHandlingStats, type HandlingCost, type HandlingSample } from "@muscle-memory/shop-domain";
import { describe, expect, it } from "vitest";
import { handlingRatios, runningZeroShare } from "./dashboard-metrics";

const cost = (values: Partial<HandlingCost> = {}): HandlingCost => ({
  handled: 2, tokenSamples: 2, timeSamples: 2, meanTokens: 95_000, meanDurationMs: 7500,
  breakdownSamples: 2, meanIntakeTokens: 0, meanRunTokens: 0, ...values,
});

describe("hero ratios from the same measured means", () => {
  it("subtracts tokens and divides active milliseconds without rounding the inputs", () => {
    expect(handlingRatios(cost(), cost({ meanTokens: 0, meanDurationMs: 17 }))).toEqual({ faster: 7500 / 17, tokensAvoided: 95_000 });
    expect(handlingRatios(cost({ meanTokens: 530197, meanDurationMs: 47448 }), cost({ meanTokens: 2615 / 6, meanDurationMs: 18.84 }))).toEqual({
      faster: 47448 / 18.84, tokensAvoided: 530197 - 2615 / 6,
    });
  });
  it.each(["agent", "recipe"])("hides ratios when %s has n = 0, even with stale means", side => {
    const missing = cost({ tokenSamples: 0, timeSamples: 0 });
    expect(handlingRatios(side === "agent" ? missing : cost(), side === "recipe" ? missing : cost())).toEqual({ faster: null, tokensAvoided: null });
  });
  it("keeps token/time coverage independent and never divides by zero or unknown", () => {
    expect(handlingRatios(cost(), cost({ meanTokens: 0, meanDurationMs: 0 }))).toEqual({ faster: null, tokensAvoided: 95_000 });
    expect(handlingRatios(cost(), cost({ tokenSamples: 0, meanTokens: null, meanDurationMs: 17 }))).toEqual({ faster: 7500 / 17, tokensAvoided: null });
    expect(handlingRatios(cost(), cost({ timeSamples: 0, meanTokens: 0, meanDurationMs: null }))).toEqual({ faster: null, tokensAvoided: 95_000 });
  });
  it("does not describe slower or more expensive recipe work as savings", () => {
    expect(handlingRatios(cost(), cost({ meanTokens: 100_000, meanDurationMs: 8000 }))).toEqual({ faster: null, tokensAvoided: null });
    expect(handlingRatios(cost({ meanTokens: 0 }), cost({ meanTokens: 0 }))).toEqual({ faster: null, tokensAvoided: 0 });
  });
});

describe("running zero-token recipe share", () => {
  it("keeps handling order and unknown/non-recipe outcomes in the denominator", async () => {
    const samples: HandlingSample[] = [
      ["agent", 95_000], ["recipe", 0], ["recipe", null], ["recipe", 0], ["agent", 0], ["recipe", 20],
    ].map(([handler, tokens], index) => ({
      requestId: `req_${index}`, handler: handler as HandlingSample["handler"], tokens: tokens as number | null,
      requestType: "damaged_item", recipe: null, completedAt: index, durationMs: null,
      intakeTokens: null, runTokens: null, agentTokens: null,
    }));
    const series = runningZeroShare(samples);
    expect(series.map(point => point.share)).toEqual([0, 1 / 2, 1 / 3, 2 / 4, 2 / 5, 2 / 6]);
    expect(series.map(point => point.requestId)).toEqual(samples.map(sample => sample.requestId));
    const stats = await new GetHandlingStats({ read: async () => ({ samples, pendingApprovals: 0, activeRecipes: 0 }) }).execute();
    expect(series[series.length - 1]?.share).toBe(stats.deterministicShare);
  });
  it("has no invented starting point for an empty cohort", () => expect(runningZeroShare([])).toEqual([]));
});
