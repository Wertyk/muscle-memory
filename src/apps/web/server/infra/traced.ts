import type { ActionRunContext } from "@agent-native/core/action";
import { readAppStateForCurrentTab } from "@agent-native/core/application-state";

export interface CapturedAction {
  actionName: string;
  input: unknown;
  output: unknown;
  caller: ActionRunContext["caller"] | null;
  navigation: unknown;
  startedAt: number;
  durationMs: number;
}
export interface TraceRecording {
  append(step: CapturedAction): Promise<void>;
  incomplete(reason: string): Promise<void>;
  reject?(): Promise<void>;
  navigation?: unknown;
}
export interface TraceCapture {
  correction?: (context: ActionRunContext | undefined, action: { actionName: string; input: unknown }) => Promise<((output: unknown) => Promise<void>) | null>;
  succeeded?: (action: { actionName: string; input: unknown; output: unknown }, context?: ActionRunContext) => Promise<void>;
  // Resolve and reserve once at entry, never move an in-flight call to another demo.
  recording(
    context: ActionRunContext | undefined,
    action: { actionName: string; input: unknown },
  ): Promise<TraceRecording | null>;
  navigation?: () => Promise<unknown>;
  now?: () => number;
}

/** Best effort reporting must never turn a successful shop effect into a retry. */
async function incomplete(recording: TraceRecording, reason: string) {
  try {
    await recording.incomplete(reason);
  } catch {
    /* Durable pending reservation prevents a false complete trace on stop. */
  }
}

export function traced<Input, Output>(
  actionName: string,
  run: (input: Input, context?: ActionRunContext) => Promise<Output>,
  capture: TraceCapture,
) {
  return async (input: Input, context?: ActionRunContext): Promise<Output> => {
    // Pin correction evidence before the effect and before navigation can change.
    let correct: ((output: unknown) => Promise<void>) | null = null;
    try { correct = await capture.correction?.(context, { actionName, input }) ?? null; } catch { /* Capture must never block shop work. */ }
    const invoke = async () => {
      const output = await run(input, context);
      try { await correct?.(output); } catch { /* Do not repeat a successful shop effect. */ }
      // Usage attribution is telemetry. A failed write must not repeat a shop effect.
      try { await capture.succeeded?.({ actionName, input, output }, context); } catch { /* Missing measurements remain unknown. */ }
      return output;
    };
    const recording = await capture.recording(context, { actionName, input });
    if (!recording) return invoke();
    const now = capture.now ?? Date.now;
    const startedAt = now();
    let snapshot: unknown;
    let navigation: unknown;
    try {
      snapshot = structuredClone(input);
      navigation = structuredClone(
        recording.navigation !== undefined
          ? recording.navigation
          : await (
              capture.navigation ??
              (() => readAppStateForCurrentTab("navigation"))
            )(),
      );
    } catch {
      await incomplete(
        recording,
        `Could not snapshot the ${actionName} step. This action is not captured.`,
      );
      return invoke();
    }
    let output: Output;
    try {
      output = await invoke();
    } catch (cause) {
      try {
        await recording.reject?.();
      } catch {
        await incomplete(
          recording,
          `Could not clear the rejected ${actionName} capture. The action failed and was not recorded as a successful step.`,
        );
      }
      throw cause;
    }
    try {
      await recording.append({
        actionName,
        input: snapshot,
        output: structuredClone(output),
        caller: context?.caller ?? null,
        navigation,
        startedAt,
        durationMs: Math.max(0, now() - startedAt),
      });
    } catch {
      await incomplete(
        recording,
        `Could not save the captured ${actionName} step. The shop action succeeded; do not repeat it.`,
      );
    }
    return output;
  };
}
