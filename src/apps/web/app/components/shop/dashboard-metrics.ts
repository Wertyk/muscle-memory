import type { HandlingCost, HandlingSample } from "@muscle-memory/shop-domain";

/** Use the hero's measured means, never totals, a different cohort or a token ratio. */
export function handlingRatios(agent: HandlingCost, recipe: HandlingCost) {
  return {
    faster: agent.timeSamples > 0 && recipe.timeSamples > 0 &&
      agent.meanDurationMs !== null && recipe.meanDurationMs !== null &&
      recipe.meanDurationMs > 0 && agent.meanDurationMs > recipe.meanDurationMs
      ? agent.meanDurationMs / recipe.meanDurationMs : null,
    tokensAvoided: agent.tokenSamples > 0 && recipe.tokenSamples > 0 &&
      agent.meanTokens !== null && recipe.meanTokens !== null && agent.meanTokens >= recipe.meanTokens
      ? agent.meanTokens - recipe.meanTokens : null,
  };
}

/** Same semantics as GetHandlingStats: unknowns stay in the denominator. */
export function runningZeroShare(samples: readonly HandlingSample[]) {
  let zero = 0;
  return samples.map((sample, index) => {
    if (sample.handler === "recipe" && sample.tokens === 0) zero++;
    return { requestId: sample.requestId, share: zero / (index + 1) };
  });
}

export const formatShare = (value: number) => new Intl.NumberFormat("en-US", {
  style: "percent", maximumFractionDigits: 1,
}).format(value);
