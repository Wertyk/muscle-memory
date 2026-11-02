import type { ActionRunContext } from "@agent-native/core/action";
import { isCorrectionCall, type Corrections } from "@muscle-memory/shop-domain";
import { demonstrationOwner, teachNavigation } from "./teach-session.js";

export function createCorrectionCapture(getCorrections: () => Corrections) {
  return async (context: ActionRunContext | undefined, action: { actionName: string; input: unknown }) => {
    const call = {
      caller: context?.caller, runId: context?.runId, toolCallId: context?.toolCallId, threadId: context?.threadId,
      owner: demonstrationOwner(context), requestId: null as string | null,
      action: action.actionName, input: action.input,
    };
    // Avoid navigation/DB work on queries, agent tools and deterministic invocations.
    if (!isCorrectionCall({ ...call, requestId: "pending" })) return null;
    const navigation = await teachNavigation();
    call.requestId = navigation?.view === "request" && typeof navigation.requestId === "string" ? navigation.requestId : null;
    return getCorrections().begin(call);
  };
}
