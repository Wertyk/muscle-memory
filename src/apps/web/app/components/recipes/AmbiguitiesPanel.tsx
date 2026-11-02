import { useT } from "@agent-native/core/client/i18n";

import { reviewQuestions, type ReviewQuestion } from "@/lib/recipe-review";
import type { RecipeDraft } from "@/lib/recipe-studio";
import { useRecipePresentation } from "@/hooks/use-recipe-presentation";
import { Button } from "@/components/ui/button";

export function AmbiguityNotice({ draft, labels, panelId }: {
  draft: RecipeDraft;
  labels: Readonly<Record<string, string>>;
  panelId: string;
}) {
  const t = useT();
  const presentation = useRecipePresentation();
  const items = reviewQuestions(draft.ambiguities, draft.content, labels, presentation);
  const count = items.filter((item) => !item.historical && !item.minor).length;
  const historical = items.filter((item) => item.historical).length;
  const focusPanel = () => {
    const panel = document.getElementById(panelId);
    panel?.scrollIntoView({ block: "start" });
    panel?.focus({ preventScroll: true });
  };
  if (!count) return historical ? <Button variant="link" size="sm" className="mb-4 h-auto max-w-full whitespace-normal p-0 text-xs text-muted-foreground" aria-controls={panelId} onClick={focusPanel}>
    {t("recipes.originalNotes", { count: historical })}
  </Button> : null;
  return <div className="recipe-circuit-ambiguity-notice">
    <span>{count} {count === 1 ? "ambiguity" : "ambiguities"} to review</span>
    <Button variant="outline" size="sm" aria-controls={panelId} onClick={focusPanel}>Review ambiguities</Button>
  </div>;
}
function Questions({ items }: { items: readonly ReviewQuestion[] }) {
  const t = useT();
  return (
    <ul className="recipe-ambiguities">
      {items.map((item, index) => (
        <li key={index}>
          <strong>{item.title}</strong>
          {item.step && !item.historical && (
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
  id,
}: {
  draft: RecipeDraft;
  labels: Readonly<Record<string, string>>;
  id?: string;
}) {
  const t = useT();
  const presentation = useRecipePresentation();
  const items = reviewQuestions(draft.ambiguities, draft.content, labels, presentation);
  const important = items.filter((item) => !item.historical && !item.minor);
  const minor = items.filter((item) => !item.historical && item.minor);
  const historical = items.filter((item) => item.historical);
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="recipe-panel" aria-label={t("recipes.ambiguities")}>
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
      {historical.length > 0 && <div className="mt-6">
        <h3 className="mb-3 text-sm text-muted-foreground">{t("recipes.rewrittenSteps")}</h3>
        <Questions items={historical} />
      </div>}
    </section>
  );
}
