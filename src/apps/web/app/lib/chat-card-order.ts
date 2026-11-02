import type { AgentMessageContentOrderResolver } from "@agent-native/toolkit/app/agentkit/react";
import { APPROVAL_CARD_RENDERER, RUN_CARD_RENDERER } from "@shared/recipe-runs";

// Attached widgets can lose their stream offsets on restore. Use the same
// presentation policy for both snapshots without changing persisted content.
export const recipeCardOrder: AgentMessageContentOrderResolver = ({ message, defaultOrder }) => {
  if (message.role !== "assistant") return defaultOrder;
  const isRecipeCard = (item: (typeof defaultOrder)[number]) => {
    const widget = item.type === "widget" ? item.widget : item.part.type === "widget" ? item.part.widget : undefined;
    return widget?.kind === RUN_CARD_RENDERER || widget?.kind === APPROVAL_CARD_RENDERER;
  };
  if (!defaultOrder.some(isRecipeCard)) return defaultOrder;
  return [...defaultOrder.filter(isRecipeCard), ...defaultOrder.filter((item) => !isRecipeCard(item))];
};
