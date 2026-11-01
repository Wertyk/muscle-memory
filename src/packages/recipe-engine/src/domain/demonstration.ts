import type { JsonObject, JsonValue, Trace, TraceStep } from "./model.js";

export interface DemonstrationOwner {
  readonly userId: string;
  readonly workspaceId: string;
}
export interface DemonstrationScope extends DemonstrationOwner {
  readonly sessionId: string;
}
export interface DemonstrationStep extends TraceStep {
  readonly sequence: number;
  readonly caller: string | null;
  readonly navigation: JsonValue;
  readonly startedAt: number;
  readonly durationMs: number;
}
/** Domain-agnostic subject and reference keys are supplied by the host app. */
export interface Demonstration extends Trace {
  readonly scope: DemonstrationScope;
  readonly subjectId: string;
  readonly references: Readonly<Record<string, string>>;
  readonly trigger: JsonObject;
  readonly status: "recording" | "completed" | "incomplete" | "cancelled";
  readonly startedAt: number;
  readonly stoppedAt: number | null;
  readonly incompleteReason: string | null;
  readonly nextSequence: number;
  readonly pending: readonly number[];
  readonly steps: readonly DemonstrationStep[];
}
export interface CaptureTicket {
  readonly demonstrationId: string;
  readonly sequence: number;
}
