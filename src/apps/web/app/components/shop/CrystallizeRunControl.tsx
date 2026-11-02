import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { Demonstration, RecipeDraft } from "@muscle-memory/recipe-engine";
import type { Request } from "@muscle-memory/shop-domain";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { recipePath } from "@/lib/recipe-studio";
import { PendingMark } from "./WorkspaceParts";

export function CrystallizeRunControl({ request }: { request: Request }) {
  const t = useT();
  const navigate = useNavigate();
  const trace = useActionQuery<Demonstration | null>("get-agent-run-demonstration", { requestId: request.id },
    { enabled: request.status === "resolved", resources: ["demonstrations", "shop"] });
  const draft = useActionMutation<RecipeDraft, { demonstrationId: string }>("draft-recipe-from-demonstration");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const demo = trace.data;
  if (request.status !== "resolved" || trace.isError || !demo || demo.source?.kind !== "agent_run" ||
    demo.status !== "completed" || demo.pending.length || demo.incompleteReason || !demo.steps.length || demo.stoppedAt === null) return null;
  async function crystallize() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await draft.mutateAsync({ demonstrationId: demo!.id });
      navigate(recipePath(result.recipe.id));
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.teachDraftFailed"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return <div className="mb-4">
    <Button disabled={pending || trace.isFetching} onClick={() => void crystallize()}>
      {pending && <PendingMark />}
      {t(pending ? "shop.teachDrafting" : "shop.crystallizeRun")}
    </Button>
    {error && <p className="shop-form-error" role="alert">{error}</p>}
  </div>;
}
