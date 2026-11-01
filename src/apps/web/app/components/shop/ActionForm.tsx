import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type {
  Order,
  Refund,
  Reply,
  Request,
  ReturnLabel,
} from "@muscle-memory/shop-domain";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { moneyText } from "@/lib/shop-workspace";

import { PendingMark } from "./WorkspaceParts";

export type ShopMutationName =
  | "send-reply"
  | "tag-request"
  | "set-request-status"
  | "escalate"
  | "issue-refund"
  | "create-replacement-order"
  | "update-shipping-address"
  | "generate-return-label";
type MutationResult = Order | Refund | Reply | Request | ReturnLabel;
export interface SavedResult {
  title: string;
  detail: string;
}
export class FormInputError extends Error {}

export function ActionForm({
  action,
  buildInput,
  label,
  successKey,
  onSaved,
  children,
  onPending,
  onCancel,
  resetOnSuccess = false,
}: {
  action: ShopMutationName;
  buildInput: (data: FormData) => Record<string, unknown>;
  label: string;
  successKey: string;
  onSaved: (result: SavedResult) => void;
  children?: ReactNode;
  onPending?: (pending: boolean) => void;
  onCancel?: () => void;
  resetOnSuccess?: boolean;
}) {
  const t = useT();
  const errorId = useId();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const mutation = useActionMutation<MutationResult, Record<string, unknown>>(
    action,
  );
  return (
    <form
      className="shop-action-form"
      aria-label={t(label)}
      aria-describedby={error ? errorId : undefined}
      aria-busy={mutation.isPending}
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current) return;
        const form = event.currentTarget;
        setError(undefined);
        inFlight.current = true;
        try {
          const input = buildInput(new FormData(form));
          onPending?.(true);
          const result = await mutation.mutateAsync(input);
          const detail =
            "body" in result
              ? result.body
              : "amount" in result
                ? `${moneyText(result.amount)} · ${result.id}`
                : result.id;
          if (resetOnSuccess) form.reset();
          onSaved({ title: t(successKey), detail });
        } catch (cause) {
          setError(
            cause instanceof FormInputError
              ? cause.message
              : (actionErrorMessage(cause) ?? t("shop.actionFailed")),
          );
        } finally {
          inFlight.current = false;
          onPending?.(false);
        }
      }}
    >
      <fieldset disabled={mutation.isPending} className="grid min-w-0 gap-4">
        {children}
      </fieldset>
      {error && (
        <p className="shop-form-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={mutation.isPending}
          >
            {t("shop.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <PendingMark />}
          {t(mutation.isPending ? "shop.pending" : label)}
        </Button>
      </div>
    </form>
  );
}

export const formText = (data: FormData, key: string) =>
  String(data.get(key) ?? "");
