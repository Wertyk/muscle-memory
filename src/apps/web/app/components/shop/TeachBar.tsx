import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
  useDbSync,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type {
  Demonstration,
  RecipeDraft,
} from "@muscle-memory/recipe-engine";
import type {
  Order,
  Request,
  StructuredRequestFields,
} from "@muscle-memory/shop-domain";
import { requestType } from "@muscle-memory/shop-domain";
import { isShopLookup } from "@shared/shop-action-kinds";
import {
  IconCheck,
  IconPlayerRecord,
  IconPlayerStop,
  IconArrowRight,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { recipePath } from "@/lib/recipe-studio";

import { TeachRequestFields } from "./TeachRequestFields";
import { TeachFilmstrip, useRecorderMotion } from "./TeachFilmstrip";
import { elapsedTime } from "./teach-recorder";
import { PendingMark } from "./WorkspaceParts";
import "./teach-recorder.css";

export { stepArgument } from "./teach-recorder";

export function TeachBar({
  request,
  order,
  onRecordingChange,
}: {
  request: Request;
  order?: Order | undefined;
  onRecordingChange?: (recording: boolean) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useActionQuery<Demonstration | null>(
    "get-demonstration",
    { requestId: request.id },
    { resources: ["demonstrations"], batchRefetches: false },
  );
  const [demo, setDemo] = useState<Demonstration | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmFields, setConfirmFields] = useState(false);
  const [now, setNow] = useState(Date.now);
  const motion = useRecorderMotion();
  const inFlight = useRef(false);
  const recorder = useRef<HTMLElement>(null);
  const tiles = useRef<{ id: string; rect: DOMRect; element: HTMLElement }[]>([]);
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
  const draft = useActionMutation<RecipeDraft, { demonstrationId: string }>(
    "draft-recipe-from-demonstration",
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
  const recording = demo?.status === "recording";
  useEffect(() => {
    onRecordingChange?.(recording);
    return () => onRecordingChange?.(false);
  }, [recording, onRecordingChange]);
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  useLayoutEffect(() => {
    if (demo?.status !== "completed") return;
    const first = tiles.current;
    tiles.current = [];
    const section = recorder.current;
    if (!motion || !section || !first.length) return;
    const origin = section.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "shop-teach-flight-layer";
    layer.style.height = `${Math.max(origin.height, ...first.map((tile) => tile.rect.bottom - origin.top))}px`;
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    const animations: Animation[] = [];
    for (const tile of first) {
      const target = [...section.querySelectorAll<HTMLElement>(".shop-teach-mini [data-step-id]")]
        .find((element) => element.dataset.stepId === tile.id);
      if (!target || !tile.rect.width || !tile.rect.height) continue;
      const last = target.getBoundingClientRect();
      const clone = tile.element;
      clone.classList.remove("shop-teach-snap");
      clone.classList.add("shop-teach-flight");
      clone.style.cssText = `left:${tile.rect.left - origin.left}px;top:${tile.rect.top - origin.top}px;width:${tile.rect.width}px;height:${tile.rect.height}px`;
      layer.append(clone);
      section.append(layer);
      // FLIP the measured full tiles into their corresponding saved-card icons.
      animations.push(clone.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${last.left - tile.rect.left}px, ${last.top - tile.rect.top}px) scale(${last.width / tile.rect.width}, ${last.height / tile.rect.height})`, opacity: 0 },
      ], { duration: 400, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }));
    }
    void Promise.all(animations.map((animation) => animation.finished)).catch(() => {}).finally(() => layer.remove());
    return () => {
      animations.forEach((animation) => animation.cancel());
      layer.remove();
    };
  }, [demo?.status, motion]);
  const canDraft = demo?.status === "completed" &&
    demo.incompleteReason === null && demo.stoppedAt !== null &&
    demo.pending.length === 0 && demo.steps.length > 0;
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
    kind: "start" | "stop" | "cancel" | "draft",
    confirmed?: StructuredRequestFields,
  ) {
    if (inFlight.current || (kind === "draft" && !canDraft)) return;
    // Completed traces are immutable. Discard here dismisses the saved card;
    // active recordings still use the shared cancellation action below.
    if (kind === "cancel" && demo?.status === "completed") {
      setDismissedId(demo.id);
      setError(null);
      return;
    }
    inFlight.current = true;
    if (kind === "stop" && motion && typeof Element.prototype.animate === "function") {
      const viewport = recorder.current?.querySelector(".shop-teach-timeline")?.getBoundingClientRect();
      tiles.current = [...(recorder.current?.querySelectorAll<HTMLElement>(".shop-teach-tile") ?? [])].map((element) => ({
        id: element.dataset.stepId!, rect: element.getBoundingClientRect(), element: element.cloneNode(true) as HTMLElement,
      })).filter((tile) => viewport && tile.rect.right > viewport.left && tile.rect.left < viewport.right);
    }
    setWorking(kind);
    setError(null);
    try {
      if (kind === "draft") {
        const result = await draft.mutateAsync({ demonstrationId: demo!.id });
        navigate(recipePath(result.recipe.id));
        return;
      }
      const result =
        kind === "start"
          ? await start.mutateAsync({
              requestId: request.id,
              ...(confirmed ? { fields: confirmed } : {}),
            })
          : await (kind === "stop" ? stop : cancel).mutateAsync({
              demonstrationId: demo!.id,
            });
      if (kind === "start") setDismissedId(null);
      setConfirmFields(false);
      if (kind !== "stop") setDemo(result);
      await query.refetch(); // Re-read the persisted trace before claiming it saved.
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t(kind === "draft" ? "shop.teachDraftFailed" : "shop.teachFailed"));
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  }
  const dismissed = demo?.id === dismissedId;
  const saved = demo?.status === "completed" && !dismissed;
  const state = dismissed ? "ready" : (demo?.status ?? "ready");
  const title = saved
      ? "shop.teachSaved"
      : demo?.status === "incomplete"
        ? "shop.teachIncomplete"
        : "shop.teachPromise";
  return (
    <section
      className="shop-teach-bar"
      ref={recorder}
      data-state={state}
      data-motion={motion ? "allowed" : "reduced"}
      aria-label={t("shop.teach")}
      aria-busy={Boolean(working)}
    >
      <div className="shop-teach-topline">
        {recording ? (
          <div className="shop-teach-identity">
            <div className="shop-teach-clock">
              <span className={`shop-teach-dot${motion ? " shop-teach-pulse" : ""}`} aria-hidden="true" />
              <span className="shop-teach-title">Recording</span>
              <span className="shop-teach-elapsed" role="timer" aria-live="off" aria-label="Recording elapsed time">{elapsedTime(demo.startedAt, now)}</span>
            </div>
            <p className="shop-teach-scope" title={`Teaching ${request.id} · ${t(`shop.types.${requestType(request) ?? "unknown"}`)}`}>
              Teaching <span>{request.id}</span> · {t(`shop.types.${requestType(request) ?? "unknown"}`)}
            </p>
          </div>
        ) : (
          <div className="shop-teach-identity">
            <span className="shop-teach-emblem" aria-hidden="true">
              {saved ? <IconCheck /> : <IconPlayerRecord />}
            </span>
            <div className="min-w-0">
              <p className="shop-teach-title">{t(title)}</p>
              <p className={saved ? "shop-teach-count" : "shop-teach-caption"}>
                {saved
                  ? `${counts} · ${elapsedTime(demo.startedAt, demo.stoppedAt ?? demo.startedAt)}`
                  : t("shop.teachHint")}
              </p>
              {saved && <TeachFilmstrip demo={demo} compact />}
            </div>
          </div>
        )}
        <div className="shop-teach-controls">
        {recording ? (
          <>
            <span className="shop-teach-count" role="status">
              {counts}
            </span>
            <Button
              variant="ghost"
              disabled={Boolean(working)}
              aria-label={t("shop.teachDiscard")}
              title={t("shop.teachDiscard")}
              onClick={() => void perform("cancel")}
            >
              Discard
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
          <>
            {saved && (
              <Button
                disabled={!canDraft || Boolean(working) || query.isPending || query.isError}
                onClick={() => void perform("draft")}
              >
                {working === "draft" ? <PendingMark /> : <IconArrowRight />}
                {t(working === "draft" ? "shop.teachDrafting" : "shop.teachCreateDraft")}
              </Button>
            )}
            {saved ? (
              <Button variant="ghost" disabled={Boolean(working)} aria-label={t("shop.teachDiscard")} title="Dismiss saved demonstration; shop changes remain saved" onClick={() => void perform("cancel")}>
                Discard
              </Button>
            ) : <Button
              disabled={Boolean(working) || query.isPending || query.isError}
              onClick={() =>
                request.content.source === "free_text"
                  ? setConfirmFields(true)
                  : void perform("start")
              }
            >
              {working === "start" ? <PendingMark /> : <IconPlayerRecord />}
              {t(working === "start" ? "shop.teachStarting" : "shop.teach")}
            </Button>}
          </>
        )}
        </div>
      </div>
      {demo && (recording || demo.status === "incomplete") && <TeachFilmstrip demo={demo} motion={motion} />}
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
      {demo && !dismissed && demo.status !== "cancelled" && (
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
