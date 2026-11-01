import type { ActionRunContext } from "@agent-native/core/action";
import {
  getCurrentRequestBrowserTabId,
  readAppStateForCurrentTab,
} from "@agent-native/core/application-state";
import { getRequestContext } from "@agent-native/core/server";
import type {
  DemonstrationOwner,
  DemonstrationScope,
} from "@muscle-memory/recipe-engine";

/** Authenticated actor + workspace + browser tab. Never accept identity in action arguments.
 * Calls without a browser tab can retrieve an owned trace by ID, but cannot record. */
export function demonstrationOwner(
  context?: ActionRunContext,
): DemonstrationOwner | null {
  const request = getRequestContext();
  const userId = (context?.userEmail ?? request?.userEmail)
    ?.trim()
    .toLowerCase();
  return userId
    ? {
        userId,
        workspaceId:
          context?.orgId === null
            ? "personal"
            : (context?.orgId ?? request?.orgId ?? "personal"),
      }
    : null;
}
export function demonstrationScope(
  context?: ActionRunContext,
): DemonstrationScope | null {
  const owner = demonstrationOwner(context);
  if (!owner) return null;
  const sessionId = getCurrentRequestBrowserTabId();
  return owner && sessionId ? { ...owner, sessionId } : null;
}
export const teachNavigation = () =>
  readAppStateForCurrentTab("navigation", { fallbackToGlobal: false });
