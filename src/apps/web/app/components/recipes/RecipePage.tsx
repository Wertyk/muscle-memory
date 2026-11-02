import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  recipeContent,
  validateStudioContent,
  type JsonObject,
  type JsonValue,
} from "@muscle-memory/recipe-engine";
import {
  IconArrowLeft,
  IconHistory,
  IconPlayerPause,
  IconPlayerPlay,
  IconVersions,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router";

import {
  EmptyState,
  PendingMark,
  QueryError,
  ShopMasthead,
  WorkspaceLoading,
} from "@/components/shop/WorkspaceParts";
import { Button } from "@/components/ui/button";
import {
  expressionLabel,
  isObject,
  RECIPES_PATH,
  replaceAtPath,
  words,
  type RecipeDetail,
  type RecipeDraft,
} from "@/lib/recipe-studio";

import { AmbiguitiesPanel } from "./AmbiguitiesPanel";
import { RecipeField, WireLegend, type ChangeField } from "./RecipeField";
import { RecipeStatus } from "./RecipesPage";
import { RecipeSteps } from "./RecipeSteps";
import { RecipeVersionDiff } from "./RecipeVersionDiff";
export function RecipePage() {
  const { recipeId = "" } = useParams();
  const t = useT();
  const detail = useActionQuery<RecipeDetail>("get-recipe", { recipeId });
  const draftQuery = useActionQuery<RecipeDraft>("get-recipe-draft", {
    recipeId,
  });
  const update = useActionMutation<
    RecipeDraft,
    { recipeId: string; expectedRevision: number; content: JsonObject }
  >("update-recipe-draft");
  const save = useActionMutation("save-recipe-version");
  const activate = useActionMutation("activate-recipe");
  const deactivate = useActionMutation("deactivate-recipe");
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  async function perform(work: () => Promise<unknown>, message: string) {
    if (busy.current) throw new Error(t("recipes.busy"));
    busy.current = true;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      setNotice(message);
    } catch (cause) {
      setError(actionErrorMessage(cause) ?? t("recipes.failed"));
      throw cause;
    } finally {
      await Promise.allSettled([detail.refetch(), draftQuery.refetch()]);
      busy.current = false;
      setPending(false);
    }
  }
  const change: ChangeField = async (base, path, value) => {
    const content = replaceAtPath(base.content, path, value);
    if (!isObject(content)) throw new Error(t("recipes.invalidContent"));
    await perform(
      () =>
        update.mutateAsync({
          recipeId,
          expectedRevision: base.revision,
          content,
        }),
      t("recipes.draftUpdated"),
    );
  };
  if (detail.isPending || draftQuery.isPending)
    return <WorkspaceLoading detail agentToggle={false} />;
  if (!detail.data || !draftQuery.data)
    return (
      <div className="shop-page">
        <ShopMasthead agentToggle={false} />
        <QueryError
          error={detail.error ?? draftQuery.error}
          retry={() => {
            void detail.refetch();
            void draftQuery.refetch();
          }}
        />
        <Link to={RECIPES_PATH} className="shop-back-link">
          {t("recipes.back")}
        </Link>
      </div>
    );
  const draft = draftQuery.data;
  const { recipe, history } = detail.data;
  const trigger = isObject(draft.content.trigger) ? draft.content.trigger : {};
  const labels: Record<string, string> = {};
  const collect = (steps: JsonValue | undefined) => {
    if (!Array.isArray(steps)) return;
    for (const step of steps)
      if (isObject(step)) {
        const action = typeof step.action === "string" ? step.action : "";
        const key = action
          ? `shop.teachActions.${action}`
          : `recipes.kinds.${step.kind}`;
        const translated = t(key);
        labels[String(step.id)] =
          translated === key ? words(action || String(step.kind)) : translated;
        collect(step.then);
        collect(step.else);
      }
  };
  collect(draft.content.steps);
  const disabled = pending || detail.isError || draftQuery.isError;
  return (
    <div className="shop-page recipe-page">
      <ShopMasthead agentToggle={false} />
      <Link to={RECIPES_PATH} className="shop-back-link">
        <IconArrowLeft className="size-4" />
        {t("recipes.back")}
      </Link>
      <header className="shop-page-heading recipe-detail-heading">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <RecipeStatus status={recipe.status} />
            <span className="text-xs text-muted-foreground">
              {recipe.activeVersionId
                ? t("recipes.runningVersion", {
                    version:
                      history.find(
                        (entry) => entry.version.id === recipe.activeVersionId,
                      )?.version.version ?? "?",
                  })
                : t("recipes.inactive")}
            </span>
          </div>
          <h1 className="shop-serif break-words">
            {String(draft.content.name ?? recipe.name)}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {recipe.status === "active" && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void perform(
                  () => deactivate.mutateAsync({ recipeId }),
                  t("recipes.deactivated"),
                ).catch(() => {})
              }
            >
              <IconPlayerPause className="size-4" />
              {t("recipes.deactivate")}
            </Button>
          )}
          <Button
            disabled={disabled || draft.issues.length > 0}
            onClick={() =>
              void perform(
                () =>
                  save.mutateAsync({
                    recipeId,
                    expectedRevision: draft.revision,
                  }),
                t("recipes.versionSaved"),
              ).catch(() => {})
            }
          >
            {pending ? <PendingMark /> : <IconVersions className="size-4" />}
            {t("recipes.saveVersion")}
          </Button>
        </div>
      </header>
      {(detail.isError || draftQuery.isError) && (
        <QueryError
          error={detail.error ?? draftQuery.error}
          stale
          retry={() => {
            void detail.refetch();
            void draftQuery.refetch();
          }}
        />
      )}
      {error && (
        <p className="shop-form-error mb-4" role="alert">
          {error}
        </p>
      )}
      <div className="recipe-notice" role="status">
        {pending
          ? t("shop.pending")
          : (notice ??
            t("recipes.editingDraft", {
              version:
                history.find(
                  (entry) => entry.version.id === draft.baseVersionId,
                )?.version.version ?? 0,
            }))}
      </div>
      <WireLegend />
      <div className="recipe-studio-grid">
        <div className="min-w-0">
          <section
            className="recipe-trigger"
            aria-labelledby="recipe-trigger-title"
          >
            <h2 id="recipe-trigger-title" className="shop-serif">
              {t("recipes.trigger")}
            </h2>
            <RecipeField
              label={t("recipes.name")}
              path={["name"]}
              kind="text"
              {...{ draft, disabled }}
              onChange={change}
            >
              <span>{String(draft.content.name ?? "")}</span>
            </RecipeField>
            <RecipeField
              label={t("recipes.event")}
              path={["trigger", "event"]}
              kind="text"
              {...{ draft, disabled }}
              onChange={change}
            >
              <span className="recipe-event">
                {trigger.event === "request.created"
                  ? t("recipes.requestCreated")
                  : String(trigger.event ?? "—")}
              </span>
            </RecipeField>
            <RecipeField
              label={t("recipes.match")}
              path={["trigger", "match"]}
              {...{ draft, disabled }}
              onChange={change}
            >
              <span>{expressionLabel(trigger.match ?? null, labels)}</span>
            </RecipeField>
          </section>
          <RecipeSteps
            steps={draft.content.steps ?? []}
            {...{ draft, labels, disabled }}
            onChange={change}
          />
          {Array.isArray(draft.content.steps) &&
            draft.content.steps.length === 0 && (
              <EmptyState title={t("recipes.noSteps")} />
            )}
          <details className="recipe-advanced">
            <summary>{t("recipes.editDsl")}</summary>
            <RecipeField
              label={t("recipes.draftContent")}
              path={[]}
              {...{ draft, disabled }}
              onChange={change}
            >
              <code>{t("recipes.dslFields")}</code>
            </RecipeField>
          </details>
          {draft.issues.length > 0 && (
            <section className="recipe-validation" role="alert">
              <h2>{t("recipes.validation")}</h2>
              <ul>
                {draft.issues.map((issue, i) => (
                  <li key={i}>
                    <code>{issue.path}</code> · {issue.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="recipe-inspector" aria-label={t("recipes.review")}>
          <AmbiguitiesPanel draft={draft} labels={labels} />
          <section className="recipe-panel recipe-backtest-slot">
            <h2 className="shop-serif">{t("recipes.backtest")}</h2>
            <p>{t("recipes.backtestSlot")}</p>
          </section>
          <section className="recipe-panel">
            <h2 className="shop-serif">
              <IconHistory className="size-5" />
              {t("recipes.history")}
            </h2>
            {!history.length && (
              <p className="text-sm text-muted-foreground">
                {t("recipes.noVersions")}
              </p>
            )}
            <ol className="recipe-history">
              {[...history].reverse().map(({ version, diff }) => (
                <li key={version.id}>
                  <details>
                    <summary>
                      <span>v{version.version}</span>
                      <span>{version.name}{version.id === recipe.activeVersionId && ` · ${t("recipes.active")}`}</span>
                    </summary>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {version.trigger.event === "request.created" ? t("recipes.requestCreated") : version.trigger.event} ·{" "}
                      {expressionLabel(version.trigger.match)}
                    </p>
                    {diff.length ? (
                      <RecipeVersionDiff entry={{version, diff}} previous={history[history.findIndex((item) => item.version.id === version.id) - 1]?.version} labels={labels} />
                    ) : (
                      <p className="my-3 text-xs text-muted-foreground">
                        {t(
                          version.version === history[0]?.version.version
                            ? "recipes.initialVersion"
                            : "recipes.sameVersion",
                        )}
                      </p>
                    )}
                    <details className="recipe-snapshot">
                      <summary>{t("recipes.snapshot")}</summary>
                      <pre>
                        {JSON.stringify(recipeContent(version), null, 2)}
                      </pre>
                    </details>
                    <Button
                      className="mt-3"
                      variant="outline"
                      size="sm"
                      disabled={
                        disabled ||
                        version.id === recipe.activeVersionId ||
                        validateStudioContent(recipeId, recipeContent(version))
                          .issues.length > 0
                      }
                      onClick={() =>
                        void perform(
                          () =>
                            activate.mutateAsync({
                              recipeId,
                              versionId: version.id,
                            }),
                          t("recipes.activated", { version: version.version }),
                        ).catch(() => {})
                      }
                    >
                      <IconPlayerPlay className="size-3.5" />
                      {t("recipes.activateVersion", {
                        version: version.version,
                      })}
                    </Button>
                  </details>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
