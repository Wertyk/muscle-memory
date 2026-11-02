import { useT } from "@agent-native/core/client/i18n";
import type { JsonValue, Run } from "@muscle-memory/recipe-engine";
import { IconChevronDown, IconPointer, IconPlus } from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { atPath, isObject, presentationContext, valueSummary } from "@/lib/recipe-presentation";
import { replayWorkspace, savedReply, savedText, type ReplayPhase, type ReplayStep, type ReplayTarget } from "@/lib/ghost-replay";
import { runRequestId } from "@shared/recipe-runs";

function Target({ id, active, children }: { id: ReplayTarget; active: ReplayTarget | null; children: ReactNode }) {
  return <div className="ghost-target" data-replay-target={id} data-active={id === active}>{children}</div>;
}

/** A visual snapshot, deliberately independent of the live workspace's queries/forms. */
export function ReplayWorkspace({ run, step, phase }: { run: Run; step: ReplayStep; phase: ReplayPhase }) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number }>();
  const snapshot = replayWorkspace(run, step.saved);
  const context = presentationContext(run);
  const target = phase.target;
  const input = isObject(step.saved.input) ? step.saved.input : {};
  const orderId = savedText(snapshot.order?.id) || savedText(input.orderId) || savedText(atPath(run.trigger, ["orderId"]));
  const requestId = runRequestId(run.trigger);
  const subject = savedText(snapshot.request?.subject) || savedText(atPath(run.trigger, ["subject"])) || requestId || t("runs.request");
  const items = Array.isArray(snapshot.order?.items) ? snapshot.order.items : [];
  const content = snapshot.request?.content ?? run.trigger;
  const originalText = savedText(atPath(content ?? null, ["text"]));
  const orderValues = step.values.filter((value) => value.path !== "orderId");
  const focusField = orderValues.find((value) => value.path === "amount") ?? orderValues[0];
  const preview = (path: string, label: string, value: string, multiline = false) => <label className="block text-sm" key={path}>
    {label}
    {multiline ? <Textarea className="mt-1.5" aria-label={label} value={value} readOnly disabled rows={4} /> : <Input className="mt-1.5" aria-label={label} value={value} readOnly disabled />}
  </label>;

  useLayoutEffect(() => {
    const container = stage.current;
    const element = container?.querySelector<HTMLElement>(`[data-replay-target="${target}"]`);
    if (!container || !element) { setCursor(undefined); return; }
    element.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const parent = container.getBoundingClientRect();
      setCursor({ x: rect.left - parent.left + Math.min(rect.width / 2, 48), y: rect.top - parent.top + Math.min(rect.height / 2, 32) });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [target, step]);

  return <div ref={stage} className="ghost-workspace" data-testid="replay-workspace"
    onClickCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <fieldset disabled aria-label={t("runs.replay.workspace")}>
      <header className="shop-request-heading">
        <p className="mb-3 font-mono text-xs text-muted-foreground">{requestId}</p>
        <h2 className="shop-serif text-3xl">{subject}</h2>
        <Target id="request-status" active={target}>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled>{t("shop.handleWithAgent")}</Button>
            <Button type="button" disabled>{phase.view === "status" ? step.name : t("shop.resolve")}</Button>
            <Button type="button" variant="outline" size="icon" aria-label={t("shop.changeStatus")} disabled><IconChevronDown /></Button>
          </div>
          {phase.view === "status" && <div className="mt-3 space-y-3">{step.values.map((value) => preview(value.path, value.label, value.value))}</div>}
        </Target>
      </header>
      <div className="shop-request-grid">
        <div className="shop-conversation">
          <section className="shop-panel shop-original-message">
            <h2>{t("shop.message")}</h2>
            {originalText ? <p className="shop-message-body">{originalText}</p> : <p className="whitespace-pre-wrap break-words text-sm">{valueSummary(content ?? null, context)}</p>}
            <div className="mt-6">
              <Target id="add-tag" active={target}><Button type="button" size="xs" variant="ghost" disabled><IconPlus />{t("shop.tag")}</Button></Target>
            </div>
            {phase.view === "tag" && <section className="ghost-preview mt-4" aria-label={t("shop.tag")}>
              <h3 className="mb-3 font-medium">{t("shop.tag")}</h3>
              <Target id="tag-input" active={target}>{preview("tag", t("shop.tag"), savedText(input.tag))}</Target>
              <Button className="mt-4" type="button" disabled>{t("shop.tag")}</Button>
            </section>}
          </section>
          <Target id="reply-composer" active={target}>
            <section className="shop-panel">
              <h2>{t("shop.reply")}</h2>
              <Textarea aria-label={t("shop.reply")} value={phase.view === "reply" ? savedReply(step.saved) : ""} readOnly disabled rows={5} />
              {phase.view === "reply" && isObject(input.variables) && <p className="mt-3 break-words text-sm text-muted-foreground">{t("shop.variables")}: {valueSummary(input.variables, context)}</p>}
              <p className="my-3 text-xs text-muted-foreground">{t("shop.replyDemo")}</p>
              <Button type="button" disabled>{t("shop.sendReply")}</Button>
            </section>
          </Target>
        </div>
        <aside className="shop-order-sidebar">
          {snapshot.customer && <section className="shop-panel"><h2>{t("shop.customer")}</h2><p>{savedText(snapshot.customer.name)}</p><p className="break-all text-sm text-muted-foreground">{savedText(snapshot.customer.email)}</p></section>}
          <section className="shop-panel">
            <div className="shop-section-heading"><h2>{t("shop.order")}</h2>
              <Target id="order-actions" active={target}><Button type="button" variant="outline" size="sm" disabled>{t("shop.orderActions")}<IconChevronDown /></Button></Target>
            </div>
            <p className="mb-4 font-mono text-sm">{orderId || t("runs.replay.notRecorded")}</p>
            {phase.view === "order-menu" && <div className="ghost-preview mb-4">
              <Target id="order-operation" active={target}><Button type="button" variant="ghost" disabled>{step.name}</Button></Target>
            </div>}
            {items.length > 0 && <ul className="shop-order-items">{items.map((item: JsonValue, index: number) => <li key={index} className="break-words text-sm">{valueSummary(item, context)}</li>)}</ul>}
            {snapshot.order?.total && <p className="mt-4 text-sm">{t("shop.total")} · {valueSummary(snapshot.order.total, context)}</p>}
            {phase.view === "order-preview" && <section className="ghost-preview mt-4" aria-label={step.name}>
              <h3 className="mb-4 font-medium">{step.name}</h3>
              <div className="space-y-4">
                {orderValues.map((value) => value === focusField
                  ? <Target id="order-preview" active={target} key={value.path}>{preview(value.path, value.label, value.value, value.path === "reason")}</Target>
                  : preview(value.path, value.label, value.value, value.path === "reason"))}
                {!step.values.some((value) => value.path !== "orderId") && <Target id="order-preview" active={target}><p className="text-sm">{t("runs.output")} · {valueSummary(step.saved.output, context)}</p></Target>}
              </div>
              <Button className="mt-4" type="button" disabled>{step.name}</Button>
            </section>}
          </section>
          {snapshot.shipment && <section className="shop-panel"><h2>{t("shop.shipment")}</h2><p className="break-words text-sm">{valueSummary(snapshot.shipment, context)}</p></section>}
        </aside>
      </div>
    </fieldset>
    {cursor && <IconPointer className="ghost-cursor size-7" aria-hidden="true" style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} />}
  </div>;
}
