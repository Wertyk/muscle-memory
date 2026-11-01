import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
  useDbSync,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type {
  Demonstration,
  DemonstrationStep,
  JsonObject,
  JsonValue,
} from "@muscle-memory/recipe-engine";
import type {
  Order,
  Request,
  StructuredRequestFields,
} from "@muscle-memory/shop-domain";
import { isShopLookup } from "@shared/shop-action-kinds";
import {
  IconCheck,
  IconPlayerRecord,
  IconPlayerStop,
  IconX,
  IconArrowRight,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { moneyText } from "@/lib/shop-workspace";

import { TeachRequestFields } from "./TeachRequestFields";
import { PendingMark } from "./WorkspaceParts";

/** Short labels from actual captured inputs/results, never invented outcomes. */
export function stepArgument(step: DemonstrationStep): string {
  const a = step.input;
  const target = [a.requestId, a.orderId, a.customerId].find(
    (v) => typeof v === "string",
  );
  const object = (value: JsonValue | undefined): JsonObject =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : {};
  const output = object(step.output);
  if (step.action === "send-reply" && typeof output.body === "string")
    return output.body;
  if (step.action === "update-shipping-address") {
    const address = object(a.address);
    return [address.line1, address.city]
      .filter((value) => typeof value === "string")
      .join(", ");
  }
  if (step.action === "create-replacement-order" && Array.isArray(output.items))
    return output.items
      .map((item) => {
        const line = object(item);
        return `${line.quantity} × ${line.name ?? line.productId}`;
      })
      .join(", ");
  const amount = object(
    a.amount ?? (step.action === "issue-refund" ? output.amount : undefined),
  );
  if (
    typeof amount.amountMinor === "number" &&
    typeof amount.currency === "string"
  )
    return `${moneyText({ amountMinor: amount.amountMinor, currency: amount.currency })} · ${target ?? ""}`;
  const value = a.tag ?? a.status ?? a.reason ?? a.template;
  if (typeof value === "string") return value;
  return typeof target === "string"
    ? target
    : Object.entries(a)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(" · ");
}
export function TeachBar({
  request,
  order,
}: {
  request: Request;
  order?: Order | undefined;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useActionQuery<Demonstration | null>(
    "get-demonstration",
    { requestId: request.id },
    { resources: ["demonstrations"], batchRefetches: false },
  );
  const [demo, setDemo] = useState<Demonstration | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmFields, setConfirmFields] = useState(false);
  const inFlight = useRef(false);
  const strip = useRef<HTMLOListElement>(null);
  const start = useActionMutation<
    Demonstration,
    { requestId: string; fields?: StructuredRequestFields }
  >("start-demonstration");
  const stop = useActionMutation<Demonstration, { demonstrationId: string }>(
    "stop-demonstration",
  );
  const cancel = useActionMutation<Demonstration, { demonstrationId: string }>(
    "cancel-demonstration",
  );
  useEffect(() => {
    if (query.data !== undefined) setDemo(query.data?.id ? query.data : null);
  }, [query.data]);
  const actions =
    demo?.steps.filter((step) => !isShopLookup(step.action)) ?? [];
  const lookups = demo?.steps.filter((step) => isShopLookup(step.action)) ?? [];
  const counts = t("shop.teachCounts", {
    actions: t(
      actions.length === 1
        ? "shop.teachActionCountOne"
        : "shop.teachActionCount",
      { count: actions.length },
    ),
    lookups: t(
      lookups.length === 1
        ? "shop.teachLookupCountOne"
        : "shop.teachLookupCount",
      { count: lookups.length },
    ),
  });
  useEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [actions.length]);
  const recording = demo?.status === "recording";
  // GET shop lookups can finish after the initiating mutation or a tool event.
  // Watch only during Teach; shared SSE/poll invalidates the demonstration resource.
  useDbSync({
    queryClient,
    ...(recording
      ? {
          realtime: {
            reason:
              "captured shop queries and agent calls can finish while the operator watches Teach",
          },
        }
      : {}),
  });
  async function perform(
    kind: "start" | "stop" | "cancel",
    confirmed?: StructuredRequestFields,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(kind);
    setError(null);
    try {
      const result =
        kind === "start"
          ? await start.mutateAsync({
              requestId: request.id,
              ...(confirmed ? { fields: confirmed } : {}),
            })
          : await (kind === "stop" ? stop : cancel).mutateAsync({
              demonstrationId: demo!.id,
            });
      setDemo(result);
      setConfirmFields(false);
      await query.refetch(); // Re-read the persisted trace before claiming it saved.
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.teachFailed"));
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  }
  const state = recording ? "recording" : (demo?.status ?? "ready");
  const title = recording
    ? "shop.teachRecording"
    : demo?.status === "completed"
      ? "shop.teachSaved"
      : demo?.status === "incomplete"
        ? "shop.teachIncomplete"
        : "shop.teachPromise";
  return (
    <section
      className="shop-teach-bar"
      data-state={state}
      aria-label={t("shop.teach")}
      aria-busy={Boolean(working)}
    >
      <div className="shop-teach-topline">
        <span className="shop-teach-emblem" aria-hidden="true">
          {demo?.status === "completed" ? <IconCheck /> : <IconPlayerRecord />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="shop-teach-title">{t(title)}</p>
          <p className="shop-teach-caption">
            {recording
              ? t("shop.teachScope")
              : demo?.status === "completed"
                ? `${demo.id} · ${counts}`
                : t("shop.teachHint")}
          </p>
        </div>
        {recording ? (
          <>
            <span className="shop-teach-count" role="status">
              {counts}
            </span>
            <Button
              variant="ghost"
              size="icon"
              disabled={Boolean(working)}
              aria-label={t("shop.teachDiscard")}
              title={t("shop.teachDiscard")}
              onClick={() => void perform("cancel")}
            >
              <IconX />
            </Button>
            <Button
              disabled={Boolean(working)}
              onClick={() => void perform("stop")}
            >
              {working ? <PendingMark /> : <IconPlayerStop />}
              {t(working ? "shop.pending" : "shop.teachStop")}
            </Button>
          </>
        ) : (
          <Button
            disabled={Boolean(working) || query.isPending || query.isError}
            onClick={() =>
              request.content.source === "free_text"
                ? setConfirmFields(true)
                : void perform("start")
            }
          >
            {working ? <PendingMark /> : <IconPlayerRecord />}
            {t(working ? "shop.teachStarting" : "shop.teach")}
          </Button>
        )}
      </div>
      {recording && !actions.length && (
        <p className="shop-teach-wait" role="status">
          <span className="shop-teach-dot" />
          {t("shop.teachWaiting")}
          <IconArrowRight className="size-4" aria-hidden="true" />
        </p>
      )}
      {demo && demo.status !== "cancelled" && actions.length > 0 && (
        <ol
          className="shop-teach-strip"
          tabIndex={0}
          ref={strip}
          aria-label={t("shop.teachCapturedActions")}
          aria-live="polite"
          aria-relevant="additions"
        >
          {actions.map((step, index) => (
            <li key={step.id}>
              <span className="shop-teach-step-number">{index + 1}</span>
              <div className="min-w-0">
                <p className="shop-teach-step-action" title={step.action}>
                  {t(`shop.teachActions.${step.action}`)}
                </p>
                <p className="shop-teach-step-args" title={stepArgument(step)}>
                  {stepArgument(step) || t("shop.teachNoArguments")}
                </p>
              </div>
              <IconCheck
                className="size-3.5 shrink-0"
                aria-label={t("shop.teachCaptured")}
              />
            </li>
          ))}
        </ol>
      )}
      {demo && demo.status !== "cancelled" && lookups.length > 0 && (
        <div
          className="shop-teach-lookups"
          role="group"
          aria-label={t("shop.teachLookups")}
          aria-live="polite"
        >
          <span>{t("shop.teachLookedUp")}</span>
          {lookups.map((step) => (
            <span
              className="shop-teach-lookup"
              key={step.id}
              title={stepArgument(step)}
              data-action={step.action}
            >
              {t(`shop.teachLookupLabels.${step.action}`)}
            </span>
          ))}
        </div>
      )}
      {demo?.status === "incomplete" && (
        <p className="shop-teach-error" role="alert">
          {demo.incompleteReason} {t("shop.teachIncompleteHint")}
        </p>
      )}
      {(error || query.isError) && (
        <div className="shop-teach-error" role="alert">
          {error ?? t("shop.teachLoadError")}
          {query.isError && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void query.refetch()}
            >
              {t("shop.retry")}
            </Button>
          )}
        </div>
      )}
      {demo && demo.status !== "cancelled" && (
        <details className="shop-teach-inspect">
          <summary>{t("shop.teachInspect")}</summary>
          <pre>
            {JSON.stringify(
              {
                id: demo.id,
                status: demo.status,
                trigger: demo.trigger,
                steps: demo.steps,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      <Dialog
        open={confirmFields}
        onOpenChange={(open) => {
          if (!working) setConfirmFields(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shop.teachFieldsTitle")}</DialogTitle>
            <DialogDescription>{t("shop.teachFieldsHint")}</DialogDescription>
          </DialogHeader>
          <TeachRequestFields
            request={request}
            order={order}
            pending={Boolean(working)}
            onConfirm={(fields) => void perform("start", fields)}
            onCancel={() => setConfirmFields(false)}
          />
          {error && (
            <p role="alert" className="shop-form-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
