import { useT } from "@agent-native/core/client/i18n";

import { reviewQuestions, type ReviewQuestion } from "@/lib/recipe-review";
import type { RecipeDraft } from "@/lib/recipe-studio";
import { useRecipePresentation } from "@/hooks/use-recipe-presentation";
function Questions({ items }: { items: readonly ReviewQuestion[] }) {
  const t = useT();
  return (
    <ul className="recipe-ambiguities">
      {items.map((item, index) => (
        <li key={index}>
          <strong>{item.title}</strong>
          {item.step && (
            <span className="recipe-ambiguity-step">{item.step}</span>
          )}
          <p>{item.question}</p>
          {item.candidates && <ul className="my-2 grid gap-1 text-sm">{item.candidates.map((candidate) => <li key={candidate}>{candidate}</li>)}</ul>}
          <details>
            <summary>{t("recipes.evidence")}</summary>
            <pre>{JSON.stringify(item.entry, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
export function AmbiguitiesPanel({
  draft,
  labels,
}: {
  draft: RecipeDraft;
  labels: Readonly<Record<string, string>>;
}) {
  const t = useT();
  const presentation = useRecipePresentation();
  const items = reviewQuestions(draft.ambiguities, draft.content, labels, presentation);
  const important = items.filter((item) => !item.minor);
  const minor = items.filter((item) => item.minor);
  return (
    <section className="recipe-panel" aria-label={t("recipes.ambiguities")}>
      <h2 className="shop-serif">
        {t("recipes.ambiguities")}
        <span
          className="recipe-count"
          aria-label={`${important.length} ${t("recipes.importantQuestions")}`}
        >
          {important.length}
        </span>
      </h2>
      {important.length ? (
        <Questions items={important} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(minor.length ? "recipes.onlyMinor" : "recipes.noAmbiguities")}
        </p>
      )}
      {minor.length > 0 && (
        <details className="recipe-minor">
          <summary>
            {t("recipes.minor")} ({minor.length})
          </summary>
          <Questions items={minor} />
        </details>
      )}
    </section>
  );
}
