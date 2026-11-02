// @vitest-environment happy-dom
import { AgentKitClient } from "@agent-native/agentkit";
import type {
  AgentToolCall,
  AgentWidget,
} from "@agent-native/agentkit/protocol";
import { AgentKitChat } from "@agent-native/toolkit/app/agentkit";
import { CoreAgentKitRoot } from "@agent-native/toolkit/app/chat/agentkit-chat";
import { PROPOSAL_CARD_RENDERER } from "@shared/recipe-proposal";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import enUS from "@/i18n/en-US";

import { damagedItemFixture } from "../../../server/fixtures/intake-recipes";
import { RecipeProposalCard } from "./RecipeProposalCard";

vi.mock("@agent-native/core/client/i18n", () => ({
  useT:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          enUS,
        );
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(values[name] ?? ""),
      );
    },
}));

describe("registered recipe-proposal renderer in the actual AgentKit transcript", () => {
  it("does not present a failed or malformed save as a saved proposal", async () => {
    const node = document.createElement("div");
    const root = createRoot(node);
    const context = {
      toolName: "save-recipe-version",
      args: {},
      isRunning: false,
    };
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <RecipeProposalCard
              context={{
                ...context,
                status: "failed",
                resultJson: { version: damagedItemFixture },
              }}
            />
          </MemoryRouter>,
        ),
      );
      expect(node.querySelector("[data-recipe-proposal]")).toBeNull();
      await act(async () =>
        root.render(
          <MemoryRouter>
            <RecipeProposalCard
              context={{
                ...context,
                status: "completed",
                resultJson: { version: { name: "Not a saved version" } },
              }}
            />
          </MemoryRouter>,
        ),
      );
      expect(node.querySelector("[data-recipe-proposal]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it.each([false, true])(
    "renders a successful saved version and optional resolution notes (notes: %s)",
    async (withNotes) => {
      const tool: AgentToolCall = {
        id: "tool_save",
        name: "save-recipe-version",
        input: { recipeId: damagedItemFixture.recipeId, expectedRevision: 1 },
        status: "completed",
        output: {
          version: damagedItemFixture,
          ...(withNotes
            ? {
                proposal: {
                  description: "Refund and reply using the damaged line.",
                  trigger: "When a customer reports a damaged purchased item.",
                  resolutions: [
                    {
                      ambiguity: "Product-specific reply",
                      resolution:
                        "Use the order line matching trigger.productId.",
                    },
                  ],
                },
              }
            : {}),
        },
      };
      const widget: AgentWidget = {
        id: "widget_proposal",
        kind: PROPOSAL_CARD_RENDERER,
        data: { toolCallId: tool.id },
      };
      const chat = new AgentKitClient({
        transport: {
          async startRun() {
            throw new Error("Offline renderer tests never call a model");
          },
          async *subscribeToRun() {},
          async cancelRun() {},
          async getThreadSnapshot() {
            return {
              id: "thread_proposal",
              createdAt: "2026-11-02T00:00:00Z",
              updatedAt: "2026-11-02T00:00:00Z",
              messages: [
                {
                  id: "message_save",
                  role: "assistant",
                  status: "complete",
                  parts: [{ type: "widget", widget }],
                },
              ],
              toolCalls: [tool],
              widgets: [{ messageId: "message_save", widget }],
            };
          },
        },
      });
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      try {
        await chat.loadThread("thread_proposal");
        await act(async () =>
          root.render(
            <MemoryRouter>
              <CoreAgentKitRoot
                controller={chat}
                threadId="thread_proposal"
                load="manual"
              >
                <AgentKitChat composer={false} />
              </CoreAgentKitRoot>
            </MemoryRouter>,
          ),
        );
        await vi.waitFor(() =>
          expect(node.querySelector("[data-recipe-proposal]")).not.toBeNull(),
        );
        const card = node.querySelector("[data-recipe-proposal]")!;
        expect(card.textContent).toContain(damagedItemFixture.name);
        expect(card.textContent).toContain("Damaged item");
        expect(card.textContent).toContain("issue refund");
        expect(card.querySelector("a")?.getAttribute("href")).toBe(
          `/recipes/${damagedItemFixture.recipeId}`,
        );
        if (withNotes) {
          expect(card.textContent).toContain(
            "When a customer reports a damaged purchased item.",
          );
          expect(card.textContent).toContain(
            "Use the order line matching trigger.productId.",
          );
          expect(card.textContent).toContain(
            "Original ambiguities remain in Studio",
          );
        }
        expect(card.textContent).not.toContain("0 tokens");
      } finally {
        await act(async () => root.unmount());
        await chat.dispose();
        node.remove();
      }
    },
  );
});
