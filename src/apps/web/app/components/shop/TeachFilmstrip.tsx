import { useT } from "@agent-native/core/client/i18n";
import type { Demonstration } from "@muscle-memory/recipe-engine";
import { isShopLookup } from "@shared/shop-action-kinds";
import {
  IconArrowRight,
  IconBolt,
  IconMapPin,
  IconMessage,
  IconPackage,
  IconReceipt,
  IconTag,
} from "@tabler/icons-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { actionIcon, elapsedTime, stepArgument } from "./teach-recorder";

const motionQuery = "(prefers-reduced-motion: no-preference)";
function subscribeMotion(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
export function useRecorderMotion() {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(motionQuery).matches, () => false);
}

export function TeachActionIcon({ action }: { action: string }) {
  const Icon = {
    receipt: IconReceipt,
    message: IconMessage,
    tag: IconTag,
    package: IconPackage,
    pin: IconMapPin,
    bolt: IconBolt,
  }[actionIcon(action)];
  return <Icon className="size-4 shrink-0" aria-hidden="true" />;
}

export function TeachFilmstrip({ demo, compact = false, motion = false }: {
  demo: Demonstration;
  compact?: boolean;
  motion?: boolean;
}) {
  const t = useT();
  const scroll = useRef<HTMLDivElement>(null);
  const actions = demo.steps.filter((step) => !isShopLookup(step.action));
  const lookups = demo.steps.filter((step) => isShopLookup(step.action));
  useEffect(() => {
    // Immediate scrolling keeps the newest action visible without another animation.
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [demo.steps.length]);
  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={compact ? "shop-teach-mini" : "shop-teach-timeline"}
        ref={scroll}
        tabIndex={0}
        aria-label={compact ? undefined : "Recording timeline"}
      >
        <div className="shop-teach-track">
          <ol className="shop-teach-strip" role="list" aria-label={t("shop.teachCapturedActions")} aria-live="polite" aria-relevant="additions">
            {actions.map((step, index) => {
              const title = t(`shop.teachActions.${step.action}`);
              const summary = stepArgument(step) || t("shop.teachNoArguments");
              return (
                <li
                  key={step.id}
                  className={`shop-teach-tile${motion && !compact ? " shop-teach-snap" : ""}`}
                  style={{ order: step.sequence }}
                  data-step-id={step.id}
                  data-action={step.action}
                >
                  {compact ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="shop-teach-mini-icon" tabIndex={0} aria-label={`${title}: ${summary}`}>
                          <TeachActionIcon action={step.action} />
                          <span className="sr-only">{title} · {summary}</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="shop-teach-tooltip max-w-72 break-words">{title} · {summary}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <>
                      <div className="shop-teach-tile-heading">
                        <TeachActionIcon action={step.action} />
                        <span className="shop-teach-step-number">{index + 1}</span>
                        <span className="shop-teach-offset">+{elapsedTime(demo.startedAt, step.startedAt)}</span>
                      </div>
                      <p className="shop-teach-step-action" title={step.action}>{title}</p>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="shop-teach-step-args" tabIndex={0} title={summary}>{summary}</p>
                        </TooltipTrigger>
                        <TooltipContent className="shop-teach-tooltip max-w-72 break-words">{summary}</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          {!compact && (
            <div className="shop-teach-lookups" role="group" aria-label={t("shop.teachLookups")}>
              {lookups.map((step) => {
                const label = t(`shop.teachLookupLabels.${step.action}`);
                const tooltip = `${label} · ${stepArgument(step)} · +${elapsedTime(demo.startedAt, step.startedAt)}`;
                return (
                  <Tooltip key={step.id}>
                    <TooltipTrigger asChild>
                      <span className="shop-teach-lookup" style={{ order: step.sequence }} data-action={step.action} tabIndex={0} aria-label={tooltip} title={tooltip}>
                        <span aria-hidden="true" />
                        <span className="sr-only">{label}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="shop-teach-tooltip">{tooltip}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}
          {!compact && demo.status === "recording" && !actions.length && (
            <p className="shop-teach-wait" role="status" style={{ order: demo.nextSequence }}>
              <span title={t("shop.teachWaiting")}>{t("shop.teachWaiting")}</span>
              <IconArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </p>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
