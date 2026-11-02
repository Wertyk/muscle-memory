import { useT } from "@agent-native/core/client/i18n";
import { recipeContent, type Binding, type JsonValue } from "@muscle-memory/recipe-engine";

import { approvalDescription } from "@/lib/recipe-approval";
import { moneyCurrency, moneyLabel } from "@/lib/recipe-money";
import { argumentLabel, atPath, differenceLabel, expressionLabel, isObject, wireSource, type RecipeDetail } from "@/lib/recipe-studio";

import { messageParts } from "./MessagePreview";
import { WireChip } from "./RecipeField";

type Entry = RecipeDetail["history"][number];
const isBinding = (value: JsonValue | undefined): value is Binding =>
  isObject(value) && ["fixed", "path", "expr", "template"].includes(String(value.mode));
const pointer = (path: readonly string[]) =>
  "/" + path.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

function stepAt(content: JsonValue, path: readonly string[]) {
  for (let length = path.length; length > 0; length--) {
    const value = atPath(content, path.slice(0, length));
    if (isObject(value) && typeof value.kind === "string") return value;
  }
  return {};
}

/** Group leaf JSON changes at the same semantic boundaries as the cards. */
export function RecipeVersionDiff({ entry, previous, labels }: {
  entry: Entry;
  previous: Entry["version"] | undefined;
  labels: Readonly<Record<string, string>>;
}) {
  const t = useT();
  const after = recipeContent(entry.version);
  const before = previous ? recipeContent(previous) : {};
  const paths = new Map<string, string[]>();
  for (const difference of entry.diff) {
    let path = difference.path.split("/").slice(1)
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const approval = path.indexOf("approval");
    if (approval >= 0) path = path.slice(0, approval + 1);
    else if (path[0] === "trigger" && path[1] === "match") path = path.slice(0, 2);
    else {
      for (let length = 1; length <= path.length; length++) {
        const ancestor = path.slice(0, length);
        if (isBinding(atPath(before, ancestor)) || isBinding(atPath(after, ancestor))) {
          path = ancestor;
          break;
        }
      }
    }
    paths.set(pointer(path), path);
  }
  function value(content: JsonValue, path: readonly string[]) {
    const field = atPath(content, path);
    const step = stepAt(content, path);
    if (path[path.length - 1] === "approval") return approvalDescription(step, labels, true);
    if (field === undefined) return "—";
    if (isBinding(field)) {
      const argument = path.slice(path.lastIndexOf("args") + 1).join(".");
      const compactLabel = field.mode === "fixed" && typeof field.value === "number" && argument.endsWith("amountMinor")
        ? moneyLabel(field.value, moneyCurrency(step, argument), labels)
        : undefined;
      return <span>
        {messageParts(field) && <span className="recipe-wire-source">{t(`recipes.sources.${wireSource(field)}`)} · </span>}
        <WireChip binding={field} labels={labels} steps={isObject(content) ? content.steps : undefined} {...(compactLabel ? { compactLabel } : {})} />
      </span>;
    }
    if (path.join(".") === "trigger.event")
      return field === "request.created" ? t("recipes.requestCreated") : String(field);
    if (isObject(field) && typeof field.kind === "string")
      return labels[String(field.id)] ?? String(field.kind);
    return path[0] === "trigger" || path[path.length - 1] === "condition"
      ? expressionLabel(field, labels)
      : typeof field === "string" ? field : JSON.stringify(field);
  }
  return (
    <ul className="recipe-diff">
      {[...paths].map(([key, path]) => {
        const content = atPath(after, path) === undefined ? before : after;
        const args = path.lastIndexOf("args");
        const label = args < 0 ? differenceLabel(key, content, labels)
          : `${differenceLabel(pointer(path.slice(0, args)), content, labels)} → ${argumentLabel(path.slice(args + 1).join("."), String(stepAt(content, path).action ?? ""))}`;
        return (
          <li key={key}>
            <strong>{label}</strong>
            <div className="recipe-diff-transition">
              <del>{value(before, path)}</del>
              <span aria-hidden="true"> → </span>
              <ins>{value(after, path)}</ins>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
