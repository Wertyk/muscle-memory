import type { ActionRunContext } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";

export interface CapturedAction {
  actionName: string;
  input: unknown;
  output: unknown;
  caller: ActionRunContext["caller"] | null;
  navigation: unknown;
  startedAt: number;
  durationMs: number;
}

export interface TraceCapture {
  // Resolve once at entry: stopping or starting a recording during a call must
  // not move that call into a different demonstration (or a different user).
  recording(context?: ActionRunContext): Promise<{
    append(step: CapturedAction): Promise<void>;
  } | null>;
  navigation?: () => Promise<unknown>;
  now?: () => number;
}

/** Wrap a defineAction `run`, inside framework validation/audit. */
export function traced<Input, Output>(
  actionName: string,
  run: (input: Input, context?: ActionRunContext) => Promise<Output>,
  capture: TraceCapture,
): (input: Input, context?: ActionRunContext) => Promise<Output> {
  return async (input, context) => {
    const recording = await capture.recording(context);
    if (!recording) return run(input, context);

    const now = capture.now ?? Date.now;
    const startedAt = now();
    const snapshot = structuredClone(input);
    const navigation = structuredClone(
      await (capture.navigation ?? (() => readAppState("navigation")))(),
    );
    const output = await run(input, context);
    // Failures are not executable demonstration steps. A persistence failure
    // propagates; callers must not silently claim that recording succeeded.
    await recording.append({
      actionName,
      input: snapshot,
      output: structuredClone(output),
      caller: context?.caller ?? null,
      navigation,
      startedAt,
      durationMs: Math.max(0, now() - startedAt),
    });
    return output;
  };
}
