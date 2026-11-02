import type { AgentMessage, AgentWidget } from "@agent-native/agentkit/protocol";
import { orderMessageContent } from "@agent-native/toolkit/app/agentkit/react";
import { APPROVAL_CARD_RENDERER, RUN_CARD_RENDERER } from "@shared/recipe-runs";
import { describe, expect, it } from "vitest";

import { recipeCardOrder } from "./chat-card-order";

const message: AgentMessage = {
  id: "reply", role: "assistant", status: "complete",
  parts: [{ type: "text", text: "One run completed; the other needs approval. Review the approval card to continue." }],
};
const widgets: AgentWidget[] = [
  { id: "run", kind: RUN_CARD_RENDERER, data: {} },
  { id: "approval", kind: APPROVAL_CARD_RENDERER, data: {} },
];

describe("recipe chat card placement", () => {
  it("keeps both cards before closing text with live widget events and after a reload without events", () => {
    const events = widgets.map((widget) => ({ type: "widget.created" as const, messageId: message.id, widget, threadId: "thread", runId: "run", id: widget.id, sequence: 1, occurredAt: "2026-11-02T00:00:00Z" }));
    const restored = orderMessageContent(message, message.parts, widgets, [], recipeCardOrder);
    const live = orderMessageContent(message, message.parts, widgets, [
      ...events,
      { type: "message.delta", messageId: message.id, text: message.parts[0]!.type === "text" ? message.parts[0]!.text : "", threadId: "thread", runId: "run", id: "text", sequence: 2, occurredAt: "2026-11-02T00:00:00Z" },
    ], recipeCardOrder);
    const keys = (items: typeof restored) => items.map((item) => item.type === "widget" ? item.widget.id : item.part.type);
    expect(keys(live)).toEqual(["run", "approval", "text"]);
    expect(keys(restored)).toEqual(keys(live));
    expect(restored.filter((item) => item.type === "part").map((item) => item.part)).toEqual(message.parts);
  });

  it("handles embedded cards while preserving all other parts and user messages", () => {
    const parts: AgentMessage["parts"] = [
      ...message.parts,
      { type: "widget", widget: widgets[0]! },
      { type: "widget", widget: { id: "other", kind: "other", data: {} } },
      { type: "widget", widget: widgets[1]! },
    ];
    const ordered = orderMessageContent({ ...message, parts }, parts, [], [], recipeCardOrder);
    expect(ordered.map((item) => item.type === "part" && item.part.type === "widget" ? item.part.widget.id : "text")).toEqual(["run", "approval", "text", "other"]);
    const user = { ...message, role: "user" as const, parts };
    expect(orderMessageContent(user, parts, [], [], recipeCardOrder)).toEqual(orderMessageContent(user, parts, [], []));
    expect(orderMessageContent(message, message.parts, [], [], recipeCardOrder)).toEqual(orderMessageContent(message, message.parts, [], []));
  });
});
