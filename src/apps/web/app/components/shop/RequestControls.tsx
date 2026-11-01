import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { REQUEST_STATUSES, type Request } from "@muscle-memory/shop-domain";
import {
  IconCheck,
  IconChevronDown,
  IconMessage,
  IconPlus,
} from "@tabler/icons-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  ActionForm,
  FormInputError,
  formText,
  type SavedResult,
} from "./ActionForm";
import { PendingMark } from "./WorkspaceParts";

export function RequestControls({
  request,
  onSaved,
}: {
  request: Request;
  onSaved: (result: SavedResult) => void;
}) {
  const t = useT();
  const [escalating, setEscalating] = useState(false);
  const [escalationPending, setEscalationPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const status = useActionMutation<
    Request,
    { requestId: string; status: string }
  >("set-request-status");
  async function setStatus(value: string) {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      await status.mutateAsync({ requestId: request.id, status: value });
      onSaved({
        title: t("shop.statusSaved"),
        detail: t(`shop.statuses.${value}`),
      });
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("shop.actionFailed"));
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Button
        variant="outline"
        onClick={() =>
          sendToAgentChat({
            message: t("shop.agentPrompt", { id: request.id }),
            context: `Current shop request: ${request.id}. Customer: ${request.customerId}. Order: ${request.orderId ?? "none"}. Read get-request for original content and current state.`,
            submit: false,
            openSidebar: true,
          })
        }
      >
        <IconMessage />
        {t("shop.handleWithAgent")}
      </Button>
      <div className="flex items-center gap-1">
        <Button
          disabled={status.isPending || request.status === "resolved"}
          onClick={() => void setStatus("resolved")}
        >
          {status.isPending ? <PendingMark /> : <IconCheck />}
          {t(request.status === "resolved" ? "shop.resolved" : "shop.resolve")}
        </Button>
        {/* Escalate opens a modal Dialog; the menu must not retain a body pointer lock. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("shop.changeStatus")}
              disabled={status.isPending}
            >
              <IconChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {REQUEST_STATUSES.filter(
              (value) => value !== "escalated" || request.escalation,
            ).map((value) => (
              <DropdownMenuItem
                key={value}
                disabled={request.status === value}
                onSelect={() => void setStatus(value)}
              >
                {t(`shop.statuses.${value}`)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => setEscalating(true)}>
              {t("shop.escalate")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <p className="shop-form-error basis-full" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={escalating}
        onOpenChange={(open) => {
          if (!escalationPending) setEscalating(open);
        }}
      >
        <DialogContent closeLabel={t("shop.close")}>
          <DialogHeader>
            <DialogTitle>{t("shop.escalate")}</DialogTitle>
            <DialogDescription>
              {t("shop.escalateDescription")}
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action="escalate"
            label="shop.escalate"
            successKey="shop.escalationSaved"
            buildInput={(data) => ({
              requestId: request.id,
              reason: formText(data, "reason"),
            })}
            onSaved={(result) => {
              onSaved(result);
              setEscalating(false);
            }}
            onPending={setEscalationPending}
            onCancel={() => setEscalating(false)}
          >
            <div>
              <Label htmlFor="escalation-reason">{t("shop.reason")}</Label>
              <Textarea
                className="mt-2"
                id="escalation-reason"
                name="reason"
                required
              />
            </div>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ReplyForm({
  request,
  onSaved,
}: {
  request: Request;
  onSaved: (result: SavedResult) => void;
}) {
  const t = useT();
  return (
    <section className="shop-panel">
      <h2>{t("shop.reply")}</h2>
      <ActionForm
        action="send-reply"
        label="shop.sendReply"
        successKey="shop.replySaved"
        onSaved={onSaved}
        resetOnSuccess
        buildInput={(data) => {
          let variables: unknown;
          try {
            variables = JSON.parse(formText(data, "variables") || "{}");
          } catch {
            throw new FormInputError(t("shop.invalidVariables"));
          }
          if (
            !variables ||
            Array.isArray(variables) ||
            typeof variables !== "object" ||
            Object.values(variables).some(
              (value) => typeof value !== "string" && typeof value !== "number",
            )
          )
            throw new FormInputError(t("shop.invalidVariables"));
          return {
            requestId: request.id,
            template: formText(data, "template"),
            variables,
          };
        }}
      >
        <Textarea
          name="template"
          rows={5}
          required
          aria-label={t("shop.reply")}
          placeholder={t("shop.replyPlaceholder")}
        />
        <details className="shop-disclosure">
          <summary>{t("shop.templateVariables")}</summary>
          <Label className="sr-only" htmlFor="reply-variables">
            {t("shop.variables")}
          </Label>
          <Textarea
            className="mt-3 font-mono text-xs"
            id="reply-variables"
            name="variables"
            defaultValue="{}"
            spellCheck={false}
          />
        </details>
        <p className="text-xs text-muted-foreground">{t("shop.replyDemo")}</p>
      </ActionForm>
    </section>
  );
}

export function TagForm({
  request,
  onSaved,
}: {
  request: Request;
  onSaved: (result: SavedResult) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {request.tags.length ? (
        request.tags.map((tag) => (
          <span className="shop-tag" key={tag}>
            {tag}
          </span>
        ))
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("shop.noTags")}
        </span>
      )}
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <IconPlus />
        {t("shop.tag")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent closeLabel={t("shop.close")}>
          <DialogHeader>
            <DialogTitle>{t("shop.tag")}</DialogTitle>
            <DialogDescription className="sr-only">
              {request.subject}
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action="tag-request"
            label="shop.tag"
            successKey="shop.tagSaved"
            onPending={setPending}
            onSaved={(result) => {
              onSaved(result);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
            buildInput={(data) => ({
              requestId: request.id,
              tag: formText(data, "tag"),
            })}
          >
            <div>
              <Label htmlFor="request-tag">{t("shop.tag")}</Label>
              <Input
                className="mt-2"
                id="request-tag"
                name="tag"
                placeholder={t("shop.tagPlaceholder")}
                required
              />
            </div>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </div>
  );
}
