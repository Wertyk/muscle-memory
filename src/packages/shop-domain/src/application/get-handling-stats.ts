import { REQUEST_TYPES, type RequestId, type RequestType } from "../domain/index.js";

export type RequestHandler = "recipe" | "agent" | "unattributed";
export interface HandlingSample {
  readonly requestId: RequestId;
  readonly requestType: RequestType | null;
  readonly handler: RequestHandler;
  readonly completedAt: number;
  /** Null is unmeasured, never an assumed zero. */
  readonly tokens: number | null;
  readonly durationMs: number | null;
  readonly intakeTokens: number | null;
  readonly runTokens: number | null;
  /** Attributed agent turns; null for recipes or unknown agent usage. */
  readonly agentTokens: number | null;
}
export interface HandlingStatsSource {
  /** Most recent completed outcomes, with one extra row to detect truncation. */
  read(limit: number): Promise<{
    samples: readonly HandlingSample[];
    pendingApprovals: number;
    activeRecipes: number;
  }>;
}
export interface HandlingCost {
  readonly handled: number;
  readonly tokenSamples: number;
  readonly timeSamples: number;
  readonly meanTokens: number | null;
  readonly meanDurationMs: number | null;
  readonly breakdownSamples: number;
  readonly meanIntakeTokens: number | null;
  readonly meanRunTokens: number | null;
}

function cost(samples: readonly HandlingSample[]): HandlingCost {
  const tokens = samples.flatMap(s => s.tokens === null ? [] : [s.tokens]);
  const times = samples.flatMap(s => s.durationMs === null ? [] : [s.durationMs]);
  const breakdown = samples.filter(s => s.tokens !== null && s.intakeTokens !== null && s.runTokens !== null);
  return {
    breakdownSamples: breakdown.length,
    meanIntakeTokens: breakdown.length ? breakdown.reduce((n, s) => n + s.intakeTokens!, 0) / breakdown.length : null,
    meanRunTokens: breakdown.length ? breakdown.reduce((n, s) => n + s.runTokens!, 0) / breakdown.length : null,
    handled: samples.length, tokenSamples: tokens.length, timeSamples: times.length,
    meanTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
    meanDurationMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
  };
}

/** Read-only application query. The adapter owns joins; this owns metric semantics. */
export class GetHandlingStats {
  constructor(private readonly source: HandlingStatsSource) {}
  async execute() {
    const limit = 100;
    const records = await this.source.read(limit + 1);
    const samples = [...records.samples].sort((a, b) => b.completedAt - a.completedAt || b.requestId.localeCompare(a.requestId))
      .slice(0, limit).reverse();
    const deterministic = samples.filter(s => s.handler === "recipe" && s.tokens === 0).length;
    return {
      samples, limit, hasMore: records.samples.length > limit,
      handled: samples.length, deterministic,
      deterministicShare: samples.length ? deterministic / samples.length : null,
      unknownTokens: samples.filter(s => s.tokens === null).length,
      unknownTime: samples.filter(s => s.durationMs === null).length,
      pendingApprovals: records.pendingApprovals, activeRecipes: records.activeRecipes,
      overall: { agent: cost(samples.filter(s => s.handler === "agent")), recipe: cost(samples.filter(s => s.handler === "recipe")) },
      comparisons: REQUEST_TYPES.map(requestType => ({
        requestType,
        agent: cost(samples.filter(s => s.requestType === requestType && s.handler === "agent")),
        recipe: cost(samples.filter(s => s.requestType === requestType && s.handler === "recipe")),
      })),
    };
  }
}
export type HandlingStats = Awaited<ReturnType<GetHandlingStats["execute"]>>;
