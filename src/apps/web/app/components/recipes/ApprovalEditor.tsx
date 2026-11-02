import { actionErrorMessage } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { JsonValue } from "@muscle-memory/recipe-engine";
import { IconPencil, IconShieldCheck } from "@tabler/icons-react";
import { useId, useState } from "react";

import { PendingMark } from "@/components/shop/WorkspaceParts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  approvalArguments,
  approvalExpression,
  approvalOperators,
  approvalDescription,
  readApproval,
  type ApprovalChoice,
  type ApprovalOperator,
} from "@/lib/recipe-approval";
import type { RecipeDraft } from "@/lib/recipe-studio";
import { useRecipePresentation } from "@/hooks/use-recipe-presentation";

import type { ChangeField, FieldPath } from "./RecipeField";

export function ApprovalEditor({
  step,
  path,
  draft,
  onChange,
  disabled,
}: {
  step: Record<string, JsonValue>;
  path: FieldPath;
  draft: RecipeDraft;
  onChange: ChangeField;
  disabled: boolean;
}) {
  const t = useT();
  const presentation = useRecipePresentation();
  const id = useId();
  const args = approvalArguments(step);
  const current = readApproval(step.approval, args);
  const [edit, setEdit] = useState<{
    base: RecipeDraft;
    choice: ApprovalChoice;
    json: string;
    advanced: boolean;
  }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const issues = draft.issues.filter((issue) =>
    issue.path.startsWith(path.join(".")),
  );
  const field = args.find((arg) => arg.path === edit?.choice.argument);
  return (
    <div
      className="recipe-field recipe-approval-field"
      data-invalid={Boolean(error) || issues.length > 0}
    >
      <div className="recipe-field-row">
        <span className="recipe-argument">{t("recipes.approval")}</span>
        <span className="recipe-approval min-w-0 flex-1">
          <IconShieldCheck className="size-4 shrink-0" />
          {approvalDescription(step, {}, false, presentation)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t("recipes.edit")} ${t("recipes.approval")}`}
          disabled={disabled || pending}
          onClick={() => {
            setError(undefined);
            setEdit({
              base: draft,
              choice: current,
              json: JSON.stringify(step.approval ?? false, null, 2),
              advanced: current.mode === "advanced",
            });
          }}
        >
          <IconPencil className="size-3.5" />
        </Button>
      </div>
      {edit && (
        <form
          className="recipe-editor"
          aria-label={t("recipes.approval")}
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            setError(undefined);
            setPending(true);
            try {
              const value: JsonValue =
                edit.advanced || edit.choice.mode === "advanced"
                  ? JSON.parse(edit.json)
                  : approvalExpression(edit.choice, args);
              await onChange(edit.base, path, value);
              setEdit(undefined);
            } catch (cause) {
              setError(
                cause instanceof SyntaxError
                  ? t("recipes.invalidJson")
                  : (actionErrorMessage(cause) ?? t("recipes.failed")),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <Label htmlFor={`${id}-policy`}>{t("recipes.approvalPolicy")}</Label>
          <Select
            value={
              edit.choice.mode === "advanced" ? "custom" : edit.choice.mode
            }
            disabled={pending}
            onValueChange={(mode) =>
              setEdit({
                ...edit,
                choice: {
                  ...edit.choice,
                  mode: mode as ApprovalChoice["mode"],
                },
                advanced: false,
              })
            }
          >
            <SelectTrigger
              id={`${id}-policy`}
              aria-label={t("recipes.approvalPolicy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">{t("recipes.never")}</SelectItem>
              <SelectItem value="always">{t("recipes.always")}</SelectItem>
              <SelectItem value="when" disabled={!args.length}>
                {t("recipes.when")}
              </SelectItem>
              {edit.choice.mode === "advanced" && (
                <SelectItem value="custom">
                  {t("recipes.customCondition")}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          {edit.choice.mode === "when" && !edit.advanced && (
            <div className="recipe-approval-controls">
              <Select
                value={edit.choice.argument}
                disabled={pending}
                onValueChange={(argument) => {
                  const selected = args.find((arg) => arg.path === argument);
                  setEdit({
                    ...edit,
                    choice: {
                      ...edit.choice,
                      argument,
                      value:
                        selected?.kind === "boolean"
                          ? "true"
                          : selected?.kind === "text"
                            ? ""
                            : "100",
                      operator:
                        selected?.kind === "boolean" ||
                        selected?.kind === "text"
                          ? "==="
                          : ">",
                    },
                  });
                }}
              >
                <SelectTrigger aria-label={t("recipes.approvalArgument")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {args.map((arg) => (
                    <SelectItem value={arg.path} key={arg.path}>
                      {arg.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={edit.choice.operator}
                disabled={pending}
                onValueChange={(operator) =>
                  setEdit({
                    ...edit,
                    choice: {
                      ...edit.choice,
                      operator: operator as ApprovalOperator,
                    },
                  })
                }
              >
                <SelectTrigger aria-label={t("recipes.approvalOperator")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {approvalOperators
                    .filter(
                      (op) =>
                        field?.kind !== "boolean" ||
                        op === "===" ||
                        op === "!==",
                    )
                    .map((op) => (
                      <SelectItem value={op} key={op}>
                        {op === "==="
                          ? t("recipes.equals")
                          : op === "!=="
                            ? t("recipes.notEquals")
                            : op}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {field?.kind === "boolean" ? (
                <Select
                  value={edit.choice.value}
                  disabled={pending}
                  onValueChange={(value) =>
                    setEdit({ ...edit, choice: { ...edit.choice, value } })
                  }
                >
                  <SelectTrigger aria-label={t("recipes.approvalValue")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">{t("recipes.yes")}</SelectItem>
                    <SelectItem value="false">{t("recipes.no")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="recipe-approval-value">
                  {field?.kind === "money" && <span aria-hidden="true">$</span>}
                  <Input
                    aria-label={t(
                      field?.kind === "money"
                        ? "recipes.approvalDollars"
                        : "recipes.approvalValue",
                    )}
                    aria-invalid={Boolean(error)}
                    aria-describedby={`${id}-errors`}
                    value={edit.choice.value}
                    disabled={pending}
                    inputMode={
                      field?.kind === "money" || field?.kind === "number"
                        ? "decimal"
                        : "text"
                    }
                    onChange={(event) =>
                      setEdit({
                        ...edit,
                        choice: { ...edit.choice, value: event.target.value },
                      })
                    }
                  />
                </div>
              )}
            </div>
          )}
          <details
            open={edit.advanced}
            onToggle={(event) => {
              const advanced = event.currentTarget.open;
              if (advanced === edit.advanced) return;
              let json = edit.json;
              if (advanced && edit.choice.mode !== "advanced") {
                try {
                  json = JSON.stringify(
                    approvalExpression(edit.choice, args),
                    null,
                    2,
                  );
                } catch {}
              }
              setEdit({ ...edit, advanced, json });
            }}
          >
            <summary>{t("recipes.advancedJson")}</summary>
            <Label htmlFor={`${id}-json`} className="sr-only">
              {t("recipes.approvalJson")}
            </Label>
            <Textarea
              id={`${id}-json`}
              className="mt-2 font-mono text-xs"
              rows={5}
              value={edit.json}
              disabled={pending}
              aria-describedby={`${id}-errors`}
              onChange={(event) =>
                setEdit({ ...edit, json: event.target.value, advanced: true })
              }
            />
          </details>
          {edit.base.revision !== draft.revision && (
            <p className="text-xs text-muted-foreground">
              {t("recipes.staleEditor")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setEdit(undefined);
                setError(undefined);
              }}
            >
              {t("shop.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={disabled || pending}>
              {pending && <PendingMark />}
              {t(pending ? "shop.pending" : "recipes.apply")}
            </Button>
          </div>
        </form>
      )}
      <div
        id={`${id}-errors`}
        className="recipe-field-errors"
        role={error || issues.length ? "alert" : undefined}
      >
        {error && <p>{error}</p>}
        {issues.map((issue, i) => (
          <p key={i}>{issue.message}</p>
        ))}
      </div>
    </div>
  );
}
