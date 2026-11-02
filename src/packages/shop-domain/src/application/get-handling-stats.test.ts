import { describe, expect, it } from "vitest";
import { GetHandlingStats, type HandlingSample } from "./get-handling-stats.js";

const sample = (n: number, values: Partial<HandlingSample> = {}): HandlingSample => ({
  requestId: `req_${n}`, requestType: "damaged_item", handler: "recipe", recipe: null, completedAt: n,
  tokens: 0, durationMs: n, intakeTokens: 0, runTokens: 0, agentTokens: null, ...values,
});
describe("GetHandlingStats", () => {
  it("keeps unknowns in the share denominator and computes independently measured same-type means", async () => {
    const query = new GetHandlingStats({ read: async () => ({ pendingApprovals: 2, activeRecipes: 3, samples: [
      sample(4, { handler: "unattributed", tokens: null, durationMs: null }),
      sample(3, { tokens: 20, durationMs: null }), sample(2, { handler: "agent", tokens: 100, durationMs: 50 }), sample(1),
    ] }) });
    const stats = await query.execute();
    expect(stats).toMatchObject({ handled: 4, deterministic: 1, deterministicShare: 0.25, unknownTokens: 1, unknownTime: 2, pendingApprovals: 2, activeRecipes: 3 });
    expect(stats.samples.map(s => s.completedAt)).toEqual([1, 2, 3, 4]);
    expect(stats.comparisons[0]).toMatchObject({
      requestType: "damaged_item", recipe: { handled: 2, tokenSamples: 2, timeSamples: 1, meanTokens: 10, meanDurationMs: 1 },
      agent: { handled: 1, tokenSamples: 1, timeSamples: 1, meanTokens: 100, meanDurationMs: 50 },
    });
    expect(stats.comparisons[1]?.agent.meanTokens).toBeNull();
  });
  it("bounds the cohort and has no invented empty-state rate or cost", async () => {
    const empty = await new GetHandlingStats({ read: async () => ({ samples: [], pendingApprovals: 0, activeRecipes: 0 }) }).execute();
    expect(empty.deterministicShare).toBeNull();
    expect(empty.comparisons.every(c => c.recipe.meanTokens === null && c.agent.meanDurationMs === null)).toBe(true);
    const stats = await new GetHandlingStats({ read: async limit => ({ samples: Array.from({ length: limit }, (_, i) => sample(i)), pendingApprovals: 0, activeRecipes: 0 }) }).execute();
    expect(stats).toMatchObject({ handled: 100, hasMore: true });
    expect(stats.samples[0]?.completedAt).toBe(1);
  });
  it("exposes head-to-head means and the intake/run split without changing totals or zero-token semantics", async () => {
    const stats = await new GetHandlingStats({ read: async () => ({ pendingApprovals: 0, activeRecipes: 0, samples: [
      sample(1, { tokens: 1308, intakeTokens: 1308, runTokens: 0 }),
      sample(2, { tokens: 0, intakeTokens: 0, runTokens: 0 }),
      sample(3, { tokens: 20, intakeTokens: 12, runTokens: 8 }),
      sample(4, { tokens: null, intakeTokens: null, runTokens: 0 }),
      sample(5, { handler: "agent", tokens: 530197, intakeTokens: 0, runTokens: 0, agentTokens: 530197, durationMs: 47448 }),
    ] }) }).execute();
    expect(stats.overall.recipe).toMatchObject({ tokenSamples: 3, breakdownSamples: 3, meanTokens: 1328 / 3, meanIntakeTokens: 1320 / 3, meanRunTokens: 8 / 3 });
    expect(stats.overall.agent).toMatchObject({ tokenSamples: 1, meanTokens: 530197, meanDurationMs: 47448 });
    expect(stats).toMatchObject({ deterministic: 1, unknownTokens: 1, deterministicShare: 0.2 });
    expect(stats.samples[0]).toMatchObject({ tokens: 1308, intakeTokens: 1308, runTokens: 0 });
  });

  it("preserves all three token components and their sum for an agent outcome", async () => {
    const query = new GetHandlingStats({ read: async () => ({ pendingApprovals: 0, activeRecipes: 0, samples: [
      sample(1, { handler: "agent", tokens: 530217, intakeTokens: 12, runTokens: 8, agentTokens: 530197 }),
    ] }) });
    const stats = await query.execute();
    const measured = stats.samples[0]!;
    expect(measured.agentTokens).toBe(530197);
    expect(measured.intakeTokens! + measured.runTokens! + measured.agentTokens!).toBe(measured.tokens);
    expect(stats.overall.agent.meanTokens).toBe(530217);
  });

});
