import { actionErrorMessage } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { Binding, JsonValue } from "@muscle-memory/recipe-engine";
import {
  IconArrowRight,
  IconBraces,
  IconLink,
  IconPencil,
  IconPointFilled,
  IconCheck,
  IconTypography,
} from "@tabler/icons-react";
import { useId, useState, type ReactNode } from "react";

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
  atPath,
  bindingLabel,
  wireSource,
  type RecipeDraft,
  type WireSource,
} from "@/lib/recipe-studio";

export type FieldPath = readonly (string | number)[];
export type ChangeField = (
  base: RecipeDraft,
  path: FieldPath,
  value: JsonValue,
) => Promise<void>;
const icons = {
  trigger: IconLink,
  output: IconArrowRight,
  constant: IconPointFilled,
  formula: IconBraces,
  template: IconTypography,
};
export function WireChip({
  binding,
  labels = {},
}: {
  binding: Binding;
  labels?: Readonly<Record<string, string>>;
}) {
  const t = useT();
  const source = wireSource(binding);
  const Icon = icons[source];
  return (
    <span className="recipe-wire" data-source={source}>
      <span className="recipe-wire-source">
        <Icon className="size-3.5" aria-hidden="true" />
        {t(`recipes.sources.${source}`)}
      </span>
      <span className="recipe-wire-value">{bindingLabel(binding, labels)}</span>
    </span>
  );
}
export function WireLegend() {
  const t = useT();
  return (
    <div className="recipe-legend" aria-label={t("recipes.wireLegend")}>
      {(
        ["trigger", "output", "constant", "formula", "template"] as WireSource[]
      ).map((source) => (
        <span key={source} data-source={source}>
          <i aria-hidden="true" />
          {t(`recipes.sources.${source}`)}
        </span>
      ))}
    </div>
  );
}
const modes = ["fixed", "path", "expr", "template"] as const;
export function RecipeField({
  label,
  path,
  draft,
  onChange,
  children,
  kind = "json",
  disabled = false,
}: {
  label: string;
  path: FieldPath;
  draft: RecipeDraft;
  onChange: ChangeField;
  children: ReactNode;
  kind?: "json" | "text" | "binding";
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const [edit, setEdit] = useState<{
    base: RecipeDraft;
    text: string;
    mode: Binding["mode"];
  }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const fieldPath = path.join(".");
  const issues = draft.issues.filter(
    (issue) =>
      issue.path === fieldPath || issue.path.startsWith(`${fieldPath}.`),
  );
  const start = () => {
    const value = atPath(draft.content, path) ?? null;
    const binding = value as unknown as Record<string, JsonValue>;
    const mode =
      kind === "binding" && modes.includes(binding?.mode as Binding["mode"])
        ? (binding.mode as Binding["mode"])
        : "fixed";
    const inner =
      kind !== "binding"
        ? value
        : mode === "fixed"
          ? binding.value
          : mode === "path"
            ? binding.path
            : mode === "expr"
              ? binding.expr
              : binding.template;
    setError(undefined);
    setEdit({
      base: draft,
      mode,
      text:
        kind === "text" ||
        (kind === "binding" && (mode === "path" || mode === "template"))
          ? String(inner ?? "")
          : (JSON.stringify(inner, null, 2) ?? "null"),
    });
  };
  return (
    <div
      className="recipe-field"
      data-invalid={issues.length > 0 || Boolean(error)}
    >
      <div className="recipe-field-row">
        <span className="recipe-argument">{label}</span>
        <div className="min-w-0 flex-1">{children}</div>
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled || pending}
          aria-label={`${t("recipes.edit")} ${label}`}
          onClick={start}
        >
          <IconPencil className="size-3.5" />
        </Button>
      </div>
      {edit && (
        <form
          className="recipe-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            setError(undefined);
            setPending(true);
            try {
              const raw: JsonValue =
                kind === "text" ||
                (kind === "binding" &&
                  (edit.mode === "path" || edit.mode === "template"))
                  ? edit.text
                  : JSON.parse(edit.text);
              const value: JsonValue =
                kind !== "binding"
                  ? raw
                  : edit.mode === "fixed"
                    ? { mode: "fixed", value: raw }
                    : edit.mode === "path"
                      ? { mode: "path", path: raw }
                      : edit.mode === "expr"
                        ? { mode: "expr", expr: raw }
                        : { mode: "template", template: raw };
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
          <Label htmlFor={id}>{label}</Label>
          {kind === "binding" && (
            <Select
              value={edit.mode}
              disabled={pending}
              onValueChange={(mode) =>
                setEdit({
                  ...edit,
                  mode: mode as Binding["mode"],
                  text:
                    mode === "fixed"
                      ? '""'
                      : mode === "expr"
                        ? '{"var":"trigger.orderId"}'
                        : "",
                })
              }
            >
              <SelectTrigger aria-label={t("recipes.bindingMode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`recipes.modes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {kind === "text" ? (
            <Input
              id={id}
              value={edit.text}
              disabled={pending}
              aria-invalid={Boolean(error) || issues.length > 0}
              aria-describedby={`${id}-help ${id}-errors`}
              onChange={(event) =>
                setEdit({ ...edit, text: event.target.value })
              }
            />
          ) : (
            <Textarea
              id={id}
              value={edit.text}
              disabled={pending}
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={Boolean(error) || issues.length > 0}
              aria-describedby={`${id}-help ${id}-errors`}
              onChange={(event) =>
                setEdit({ ...edit, text: event.target.value })
              }
            />
          )}
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {t(
              kind === "binding"
                ? `recipes.hints.${edit.mode}`
                : kind === "json"
                  ? "recipes.jsonHint"
                  : "recipes.textHint",
            )}
          </p>
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
            <Button type="submit" size="sm" disabled={pending || disabled}>
              {pending ? <PendingMark /> : <IconCheck className="size-3.5" />}
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
          <p key={i}>
            {issue.path}: {issue.message}
          </p>
        ))}
      </div>
    </div>
  );
}
