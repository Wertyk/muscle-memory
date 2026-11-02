import { actionErrorMessage, callAction, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { requestType, type Request } from "@muscle-memory/shop-domain";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { RequestProcessing } from "@shared/request-processing";
import { intakeSummary } from "@/lib/kiln";
import { Button } from "@/components/ui/button";
import { PendingMark } from "./WorkspaceParts";

export function DemoIntakeControl({ onStart, onArrived, filters = {} }: {
  onStart?: () => void;
  onArrived?: (requests: readonly Request[], rows: readonly RequestProcessing[]) => void;
  filters?: { status?: string | undefined; type?: string | undefined; processing?: string | undefined };
}) {
  const t = useT();
  const busy = useRef(false);
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const [arrived, setArrived] = useState<readonly Request[]>();
  const [outcomes, setOutcomes] = useState<readonly RequestProcessing[]>();
  const [pending, setPending] = useState(false);
  const mutation = useActionMutation<readonly Request[], Record<string, never>>("demo-intake");
  async function simulate() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setArrived(undefined);
    setOutcomes(undefined);
    onStart?.();
    try {
      const requests = await mutation.mutateAsync({});
      setArrived(requests);
      let rows: readonly RequestProcessing[] | undefined;
      try {
        rows = await callAction<readonly RequestProcessing[]>("list-request-processing", { requestIds: requests.map(request => request.id) }, { method: "GET" });
      } catch {
        // The batch succeeded. Missing summary evidence must not report a failed intake.
      }
      setOutcomes(rows);
      onArrived?.(requests, rows ?? []);
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.demoFailed"));
      await client.invalidateQueries({ queryKey: ["action"] });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const hidden = arrived?.some(request =>
    (filters.status && request.status !== filters.status) ||
    (filters.type && requestType(request) !== filters.type) ||
    (filters.processing && outcomes && outcomes.find(row => row.requestId === request.id)?.state !== filters.processing));
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void simulate()}>
        {pending && <PendingMark />}
        {t(pending ? "shop.demoSimulating" : "shop.demoSimulate")}
      </Button>
      <span className="text-xs text-muted-foreground">{t("shop.demoEffects")}</span>
      <span role="status" className="text-xs text-muted-foreground">
        {arrived && (outcomes ? intakeSummary(arrived.map(request => request.id), outcomes) : `${arrived.length} arrived`)}
        {hidden && " · Some new requests are hidden by your filters."}
      </span>
      {error && (
        <p role="alert" className="shop-form-error basis-full">
          {error} {t("shop.demoInspectBeforeRetry")}
        </p>
      )}
    </div>
  );
}
