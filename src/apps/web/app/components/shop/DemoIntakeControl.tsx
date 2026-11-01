import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { Request } from "@muscle-memory/shop-domain";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { PendingMark } from "./WorkspaceParts";

export function DemoIntakeControl() {
  const t = useT();
  const busy = useRef(false);
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const [count, setCount] = useState<number>();
  const [pending, setPending] = useState(false);
  const mutation = useActionMutation<readonly Request[], Record<string, never>>("demo-intake");
  async function simulate() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setCount(undefined);
    try {
      const requests = await mutation.mutateAsync({});
      setCount(requests.length);
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.demoFailed"));
      await client.invalidateQueries({ queryKey: ["action"] });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void simulate()}>
        {pending && <PendingMark />}
        {t(pending ? "shop.demoSimulating" : "shop.demoSimulate")}
      </Button>
      <span className="text-xs text-muted-foreground">{t("shop.demoEffects")}</span>
      <span role="status" className="text-xs text-muted-foreground">
        {count !== undefined && t("shop.demoAdded", { count })}
      </span>
      {error && (
        <p role="alert" className="shop-form-error basis-full">
          {error} {t("shop.demoInspectBeforeRetry")}
        </p>
      )}
    </div>
  );
}
