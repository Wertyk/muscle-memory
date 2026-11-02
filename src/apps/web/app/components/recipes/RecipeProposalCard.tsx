import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  registerActionChatRenderer,
  type ToolRendererProps,
} from "@agent-native/toolkit/app/chat";
import type { Step } from "@muscle-memory/recipe-engine";
import {
  PROPOSAL_CARD_RENDERER,
  recipeProposalSchema,
} from "@shared/recipe-proposal";
import { Link } from "react-router";

import { RecipeVersionDiff } from "./RecipeVersionDiff";
import { expressionLabel, recipePath, type RecipeDetail } from "@/lib/recipe-studio";
import { stepLabel } from "@/lib/recipe-presentation";

function ProposalSteps({ steps }: { steps: readonly Step[] }) {
  const t = useT();
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5">
      {steps.map((step) => (
        <li key={step.id}>
          {stepLabel({ kind: step.kind, action: step.kind === "action" ? step.action : null }, t)}
          {step.kind === "branch" && (
            <>
              {` · ${expressionLabel(step.condition)}`}
              <ProposalSteps steps={step.then} />
              <ProposalSteps steps={step.else} />
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

export function RecipeProposalCard({ context }: ToolRendererProps) {
  const t = useT();
  const parsed = recipeProposalSchema.safeParse(context.resultJson);
  if (context.status !== "completed" || !parsed.success) return null;
  const { version, proposal, correctionId } = parsed.data;
  return (
    <article
      className="run-chat-card"
      data-recipe-proposal={version.id}
      aria-label={t("recipes.proposal")}
    >
      <p className="text-xs text-muted-foreground">
        {t("recipes.proposalSaved", { version: version.version })}
      </p>
      <h3 className="mt-2 break-words font-semibold">{version.name}</h3>
      {proposal && <p className="mt-2 text-sm">{proposal.description}</p>}
      <h4 className="mt-3 text-sm font-semibold">{t("recipes.trigger")}</h4>
      {proposal && <p className="text-sm">{proposal.trigger}</p>}
      <p className="mt-1 text-sm text-muted-foreground">
        {expressionLabel(version.trigger.match)}
      </p>
      <h4 className="mt-3 text-sm font-semibold">{t("recipes.steps")}</h4>
      <ProposalSteps steps={version.steps} />
      {proposal && (
        <>
          <h4 className="mt-3 text-sm font-semibold">
            {t("recipes.proposedResolutions")}
          </h4>
          <ul className="mt-2 space-y-2 text-sm">
            {proposal.resolutions.map((item, index) => (
              <li key={index}>
                <strong>{item.ambiguity}</strong>
                <p>{item.resolution}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("recipes.resolutionEvidence")}
          </p>
        </>
      )}
      {correctionId && <CorrectionProposalDiff recipeId={version.recipeId} versionId={version.id} />}
      <Link
        className="shop-record-link mt-4 inline-block text-sm underline underline-offset-4"
        to={recipePath(version.recipeId) + (correctionId ? `#version-${version.id}` : "")}
      >
        {t("recipes.openStudio")} →
      </Link>
    </article>
  );
}

function CorrectionProposalDiff({ recipeId, versionId }: { recipeId: string; versionId: string }) {
  const t = useT();
  const query = useActionQuery<RecipeDetail>("get-recipe", { recipeId });
  const index = query.data?.history.findIndex(entry => entry.version.id === versionId) ?? -1;
  const entry = query.data?.history[index];
  if (!entry) return <p className="mt-3 text-xs text-muted-foreground">{t(query.isError ? "corrections.diffUnavailable" : "corrections.loadingDiff")}</p>;
  const labels: Record<string, string> = {};
  const collect = (steps: readonly Step[]) => steps.forEach(step => {
    labels[step.id] = stepLabel({ kind: step.kind, action: step.kind === "action" ? step.action : null }, t);
    if (step.kind === "branch") { collect(step.then); collect(step.else); }
  });
  collect(entry.version.steps);
  return <div className="mt-3"><RecipeVersionDiff entry={entry} previous={query.data?.history[index - 1]?.version} labels={labels} /></div>;
}

registerActionChatRenderer({
  id: PROPOSAL_CARD_RENDERER,
  renderer: PROPOSAL_CARD_RENDERER,
  Component: RecipeProposalCard,
});
