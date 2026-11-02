import { useActionQuery } from "@agent-native/core/client/hooks";
import type { Demonstration, RecipeDraft, Run } from "@muscle-memory/recipe-engine";
import type { RunSummary } from "@shared/recipe-runs";
import { createContext, useContext, type ReactNode } from "react";

import { presentationContext, type PresentationContext } from "@/lib/recipe-presentation";

const Context = createContext<PresentationContext>({});
export const useRecipePresentation = () => useContext(Context);

export function RecipePresentationProvider({ recipeId, originalVersionId, children }: {
  recipeId: string; originalVersionId: string | undefined; children: ReactNode;
}) {
  const original = useActionQuery<RecipeDraft | null>("get-recipe-draft", { versionId: originalVersionId }, { enabled: Boolean(originalVersionId) });
  const demonstrationId = original.data?.demonstrationId;
  const demonstration = useActionQuery<Demonstration | null>("get-demonstration", { demonstrationId }, { enabled: Boolean(demonstrationId) });
  const runs = useActionQuery<readonly RunSummary[]>("list-recipe-runs", { recipeId });
  const latest = [...(runs.data ?? [])].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
  const run = useActionQuery<Run>("get-recipe-run", { runId: latest?.id }, { enabled: Boolean(latest) });
  return <Context.Provider value={presentationContext(run.data, demonstration.data)}>{children}</Context.Provider>;
}
