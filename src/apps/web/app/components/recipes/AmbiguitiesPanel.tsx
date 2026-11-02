import { useT } from "@agent-native/core/client/i18n";

import { reviewQuestions, type ReviewQuestion } from "@/lib/recipe-review";
import type { RecipeDraft } from "@/lib/recipe-studio";
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
  const items = reviewQuestions(draft.ambiguities, draft.content, labels);
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
