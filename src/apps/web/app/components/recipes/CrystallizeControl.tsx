import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type {
  Demonstration,
  RecipeDraft as OriginalDraft,
} from "@muscle-memory/recipe-engine";
import { IconMessage } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { reviewQuestions } from "@/lib/recipe-review";
import type { RecipeDraft } from "@/lib/recipe-studio";

export function CrystallizeControl({
  draft,
  originalVersionId,
  disabled,
}: {
  draft: RecipeDraft;
  originalVersionId: string | undefined;
  disabled: boolean;
}) {
  const t = useT();
  const original = useActionQuery<OriginalDraft | null>(
    "get-recipe-draft",
    {
      versionId: originalVersionId,
    },
    { enabled: Boolean(originalVersionId) },
  );
  const demonstrationId = original.data?.demonstrationId;
  const demonstration = useActionQuery<Demonstration | null>(
    "get-demonstration",
    {
      demonstrationId,
    },
    { enabled: Boolean(demonstrationId) },
  );
  const questions = reviewQuestions(draft.ambiguities, draft.content, {});
  const trigger = demonstration.data?.trigger;
  return (
    <>
    {demonstration.data && <span className="max-w-full self-center break-all text-xs text-muted-foreground">
      {demonstration.data.source?.kind === "agent_run"
        ? t("recipes.learnedFromAgent", { thread: demonstration.data.source.threadId })
        : t("recipes.learnedFromTeach", { demonstration: demonstration.data.id })}
    </span>}
    <Button
      variant="outline"
      disabled={disabled || original.isFetching || demonstration.isFetching}
      onClick={() =>
        sendToAgentChat({
          message: t("recipes.crystallizePrompt"),
          context: JSON.stringify({
            workflow: "crystallize",
            recipeId: draft.recipeId,
            draftId: draft.baseVersionId,
            originalVersionId,
            revision: draft.revision,
            ambiguityCount: draft.ambiguities.length,
            demonstrationId,
            request: trigger
              ? Object.fromEntries(
                  [
                    "requestId",
                    "orderId",
                    "customerId",
                    "type",
                    "productId",
                    "quantity",
                    "subject",
                  ]
                    .filter((key) => trigger[key] !== undefined)
                    .map((key) => [
                      key,
                      typeof trigger[key] === "string"
                        ? trigger[key].slice(0, 300)
                        : trigger[key],
                    ]),
                )
              : null,
            ambiguities: questions.slice(0, 20).map(({ entry, question, candidates }) => ({
              kind:
                typeof entry === "object" && entry && "kind" in entry
                  ? entry.kind
                  : "review",
              question: [question, ...(candidates ?? [])].join("\n").slice(0, 600),
            })),
            omittedAmbiguities: Math.max(0, questions.length - 20),
          }),
          submit: true,
          openSidebar: true,
        })
      }
    >
      <IconMessage className="size-4" />
      {t("recipes.crystallize")}
    </Button>
    </>
  );
}
