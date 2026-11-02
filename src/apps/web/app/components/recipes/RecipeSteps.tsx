import { useT } from "@agent-native/core/client/i18n";
import type { Binding, JsonValue } from "@muscle-memory/recipe-engine";
import { IconArrowFork } from "@tabler/icons-react";

import {
  argumentLabel,
  atPath,
  expressionLabel,
  isObject,
  words,
  type RecipeDraft,
} from "@/lib/recipe-studio";
import { moneyLabel, resolvedCurrency, valueSummary } from "@/lib/recipe-presentation";
import { useRecipePresentation } from "@/hooks/use-recipe-presentation";

import { ApprovalEditor } from "./ApprovalEditor";
import {
  RecipeField,
  WireChip,
  type ChangeField,
  type FieldPath,
} from "./RecipeField";

function BindingFields({
  value,
  path,
  label,
  draft,
  onChange,
  labels,
  disabled,
  action = "",
  variables,
}: {
  action?: string;
  variables?: JsonValue | undefined;
  value: JsonValue;
  path: FieldPath;
  label: string;
  draft: RecipeDraft;
  onChange: ChangeField;
  labels: Record<string, string>;
  disabled: boolean;
}) {
  const presentation = useRecipePresentation();
  if (
    isObject(value) &&
    isObject(value.amountMinor) &&
    isObject(value.currency)
  ) {
    const amount = value.amountMinor as unknown as Binding;
    const currency = value.currency as unknown as Binding;
    const argsIndex = path.lastIndexOf("args");
    const step = atPath(draft.content, path.slice(0, argsIndex));
    const currencyLabel = resolvedCurrency(value.currency, presentation,
      isObject(step) ? String(step.id) : undefined,
      [...path.slice(argsIndex + 1), "amountMinor"].join("."));
    const amountLabel = amount.mode === "fixed" && typeof amount.value === "number"
      ? moneyLabel(amount.value, currencyLabel) : undefined;
    return (
      <div className="recipe-money-fields">
        <RecipeField
          label={label}
          path={[...path, "amountMinor"]}
          kind="binding"
          {...{ draft, onChange, disabled }}
        >
          <WireChip binding={amount} labels={labels} {...(amountLabel ? { compactLabel: amountLabel } : {})} />
        </RecipeField>
        <div className="recipe-currency-field">
          <RecipeField
            label="Currency"
            path={[...path, "currency"]}
            kind="binding"
            {...{ draft, onChange, disabled }}
          >
            <WireChip
              binding={currency}
              labels={labels}
              compactLabel={currencyLabel}
            />
          </RecipeField>
        </div>
      </div>
    );
  }
  if (
    isObject(value) &&
    value.mode === "fixed" &&
    isObject(value.value) &&
    typeof value.value.amountMinor === "number" &&
    typeof value.value.currency === "string"
  ) {
    const amount = valueSummary(value.value, presentation);
    return (
      <RecipeField
        {...{ path, label, draft, onChange, disabled }}
        kind="binding"
      >
        <WireChip
          binding={value as unknown as Binding}
          labels={labels}
          compactLabel={amount}
        />
      </RecipeField>
    );
  }
  if (
    isObject(value) &&
    ["fixed", "path", "expr", "template"].includes(String(value.mode))
  ) {
    return (
      <RecipeField
        {...{ path, label, draft, onChange, disabled }}
        kind="binding"
      >
        <WireChip
          binding={value as unknown as Binding}
          labels={labels}
          steps={draft.content.steps}
          variables={
            action === "send-reply" && path[path.length - 1] === "template"
              ? variables
              : undefined
          }
        />
      </RecipeField>
    );
  }
  if (value && typeof value === "object")
    return (
      <>
        {Object.entries(value)
          .filter(
            ([key, child]) =>
              key !== "variables" ||
              !(
                isObject(child) &&
                (Object.keys(child).length === 0 ||
                  (child.mode === "fixed" &&
                    isObject(child.value) &&
                    Object.keys(child.value).length === 0))
              ),
          )
          .map(([key, child]) => (
            <BindingFields
              key={key}
              value={child}
              path={[...path, Array.isArray(value) ? Number(key) : key]}
              label={
                label ? `${label} · ${words(key)}` : argumentLabel(key, action)
              }
              {...{ draft, onChange, labels, disabled, action, variables }}
            />
          ))}
      </>
    );
  return (
    <RecipeField {...{ path, label, draft, onChange, disabled }}>
      <code>{JSON.stringify(value)}</code>
    </RecipeField>
  );
}
export function RecipeSteps({
  steps,
  path = ["steps"],
  draft,
  onChange,
  labels,
  disabled,
}: {
  steps: JsonValue;
  path?: FieldPath;
  draft: RecipeDraft;
  onChange: ChangeField;
  labels: Record<string, string>;
  disabled: boolean;
}) {
  const t = useT();
  if (!Array.isArray(steps))
    return (
      <RecipeField
        label={t("recipes.steps")}
        {...{ path, draft, onChange, disabled }}
      >
        <span>{t("recipes.invalidSteps")}</span>
      </RecipeField>
    );
  return (
    <ol className="recipe-flow">
      {steps.map((step, index) => {
        if (!isObject(step))
          return (
            <li key={index}>
              <RecipeField
                label={`${t("recipes.step")} ${index + 1}`}
                path={[...path, index]}
                {...{ draft, onChange, disabled }}
              >
                <code>{JSON.stringify(step)}</code>
              </RecipeField>
            </li>
          );
        const current = [...path, index];
        const kind = String(step.kind);
        const label =
          labels[String(step.id)] ?? words(String(step.action ?? kind));
        return (
          <li key={`${index}-${step.id}`} className="recipe-step">
            <span className="recipe-step-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <article className="recipe-step-card" aria-label={label}>
              <header className="recipe-step-heading">
                <h3>{label}</h3>
                <span className="recipe-kind">
                  {t(`recipes.kinds.${kind}`)} · {String(step.id ?? "?")}
                </span>
              </header>
              {kind === "action" && (
                <BindingFields
                  value={step.args ?? {}}
                  path={[...current, "args"]}
                  label=""
                  action={String(step.action)}
                  variables={
                    isObject(step.args) ? step.args.variables : undefined
                  }
                  {...{ draft, onChange, labels, disabled }}
                />
              )}
              {kind === "extract" && (
                <>
                  <BindingFields
                    value={step.text ?? null}
                    path={[...current, "text"]}
                    label={t("recipes.text")}
                    {...{ draft, onChange, labels, disabled }}
                  />
                  <RecipeField
                    label={t("recipes.extractFields")}
                    path={[...current, "fields"]}
                    {...{ draft, onChange, disabled }}
                  >
                    <span>
                      {isObject(step.fields)
                        ? Object.entries(step.fields)
                            .map(
                              ([name, field]) =>
                                `${words(name)} (${isObject(field) ? field.type : "?"})`,
                            )
                            .join(", ")
                        : t("recipes.invalidSteps")}
                    </span>
                  </RecipeField>
                  <p className="recipe-extraction-note">
                    {t("recipes.extractionNote")}
                  </p>
                </>
              )}
              {kind === "handoff" && (
                <>
                  <RecipeField
                    label={t("recipes.target")}
                    path={[...current, "to"]}
                    kind="text"
                    {...{ draft, onChange, disabled }}
                  >
                    <span>{String(step.to)}</span>
                  </RecipeField>
                  <BindingFields
                    value={step.note ?? null}
                    path={[...current, "note"]}
                    label={t("recipes.note")}
                    {...{ draft, onChange, labels, disabled }}
                  />
                </>
              )}
              {kind === "branch" && (
                <>
                  <RecipeField
                    label={t("recipes.condition")}
                    path={[...current, "condition"]}
                    {...{ draft, onChange, disabled }}
                  >
                    <span className="recipe-condition">
                      <IconArrowFork className="size-4 shrink-0" />
                      {expressionLabel(step.condition ?? null, labels)}
                    </span>
                  </RecipeField>
                  {(["then", "else"] as const).map((side) => (
                    <section className="recipe-branch" key={side}>
                      <h4>
                        {t(
                          side === "then"
                            ? "recipes.ifTrue"
                            : "recipes.otherwise",
                        )}
                      </h4>
                      <RecipeSteps
                        steps={step[side] ?? []}
                        path={[...current, side]}
                        {...{ draft, onChange, labels, disabled }}
                      />
                    </section>
                  ))}
                </>
              )}
              <ApprovalEditor
                step={step}
                path={[...current, "approval"]}
                {...{ draft, onChange, disabled }}
              />
            </article>
          </li>
        );
      })}
    </ol>
  );
}
