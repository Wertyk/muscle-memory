/** Operational evidence, independent of the recipe engine's executable DSL. */
export interface CorrectionOwner {
  readonly userId: string;
  readonly workspaceId: string;
}
export interface CorrectionVersion {
  readonly id: string;
  readonly recipeId: string;
  readonly version: number;
}
export interface Correction {
  readonly id: string;
  readonly owner: CorrectionOwner;
  readonly requestId: string;
  readonly runId: string;
  readonly recipe: CorrectionVersion;
  readonly stepId: string;
  readonly action: "send-reply" | "issue-refund" | "tag-request";
  readonly originalInput: unknown;
  readonly originalOutput: unknown;
  readonly input: unknown;
  readonly output: unknown;
  readonly createdAt: number;
  readonly status: "recorded" | "proposed" | "accepted" | "rejected";
  readonly proposal: { readonly version: CorrectionVersion; readonly notes: unknown } | null;
  readonly decision: { readonly at: number; readonly by: CorrectionOwner; readonly reason: string | null } | null;
}
