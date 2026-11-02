import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { IconArrowUpRight, IconRoute } from "@tabler/icons-react";
import { Link } from "react-router";

import {
  EmptyState,
  QueryError,
  ShopMasthead,
  WorkspaceLoading,
} from "@/components/shop/WorkspaceParts";
import {
  recipePath,
  type RecipeSummary,
} from "@/lib/recipe-studio";

export function RecipeStatus({ status }: { status: "draft" | "active" }) {
  const t = useT();
  return (
    <span
      className="shop-status"
      data-status={status === "active" ? "resolved" : "pending"}
    >
      <span aria-hidden="true" />
      {t(`recipes.${status}`)}
    </span>
  );
}
export function RecipesPage() {
  const t = useT();
  const query = useActionQuery<readonly RecipeSummary[]>("list-recipes", {});
  if (query.isPending) return <WorkspaceLoading agentToggle={false} />;
  return (
    <div className="shop-page recipe-page">
      <ShopMasthead agentToggle={false} />
      <header className="shop-page-heading">
        <h1 className="shop-serif">{t("recipes.title")}</h1>
        <IconRoute
          className="size-7 text-primary"
          strokeWidth={1.3}
          aria-hidden="true"
        />
      </header>
      {query.isError && (
        <QueryError
          error={query.error}
          stale={Boolean(query.data)}
          retry={() => void query.refetch()}
        />
      )}
      {query.data?.length === 0 && (
        <EmptyState title={t("recipes.empty")}>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("recipes.emptyHint")}
          </p>
        </EmptyState>
      )}
      {Boolean(query.data?.length) && (
        <div className="recipe-table-scroll">
          <table className="recipe-table">
            <thead>
              <tr>
                {["name", "status", "version", "runs", "lastResult"].map(
                  (key) => (
                    <th key={key} scope="col">
                      {t(`recipes.${key}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {query.data?.map((recipe) => (
                <tr key={recipe.id}>
                  <th scope="row">
                    <Link
                      to={recipePath(recipe.id)}
                      className="shop-request-link"
                    >
                      <span>{recipe.name}</span>
                      <IconArrowUpRight className="size-4 shrink-0" />
                    </Link>
                    <span className="mt-2 block font-mono text-xs font-normal text-muted-foreground">
                      {recipe.id}
                    </span>
                  </th>
                  <td>
                    <RecipeStatus status={recipe.status} />
                  </td>
                  <td className="tabular-nums">
                    {recipe.version ? `v${recipe.version}` : "—"}
                  </td>
                  <td className="tabular-nums">{recipe.runs}</td>
                  <td>
                    {recipe.lastResult
                      ? t(`recipes.results.${recipe.lastResult}`)
                      : t("recipes.noRuns")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
