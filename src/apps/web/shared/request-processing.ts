import type { MatchReason, TokenUsage } from "@muscle-memory/recipe-engine";
import type { RequestId } from "@muscle-memory/shop-domain";

export const PROCESSING_STATES = ["auto_handled", "awaiting_approval", "with_agent", "done"] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];
export interface RequestProcessing {
  readonly requestId: RequestId;
  readonly runId: string;
  /** No final outcome yet; seeded requests have no processing row at all. */
  readonly state: ProcessingState | null;
  readonly matchReason: MatchReason | null;
  readonly tokens: TokenUsage;
}
