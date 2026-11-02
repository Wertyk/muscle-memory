import { createAgentChatPlugin } from "@agent-native/core/server";
import { splitAgentKitMessageContext } from "@agent-native/agentkit";
import { H3 } from "h3";
import { describe, expect, it, vi } from "vitest";

import { ENGLISH_OUTPUT_INSTRUCTION, ENGLISH_TITLE_INSTRUCTION, prepareEnglishAgentRequest, prepareEnglishChatTitle } from "./agent-output.js";
import titleMiddleware from "./middleware/english-chat-title.js";

vi.mock("@agent-native/core/server", () => ({
  createAgentChatPlugin: vi.fn(() => () => {}),
  loadActionsFromStaticRegistry: () => ({}),
}));
vi.mock("../.generated/actions-registry.js", () => ({ default: {} }));
await import("./plugins/agent-chat.js");
const options = vi.mocked(createAgentChatPlugin).mock.calls[0]![0]!;

describe("agent output policy", () => {
  it("carries English guidance into the follow-up completion's bounded request tail without changing the displayed request", () => {
    const message = "Inspect this request. " + "Customer content. ".repeat(1000);
    const prepared = prepareEnglishAgentRequest({ message });
    expect(prepared.message.slice(-1500)).toContain(ENGLISH_OUTPUT_INSTRUCTION);
    expect(prepared.message).toContain(message);
    expect(prepared.displayMessage.slice(-1500)).toContain(ENGLISH_OUTPUT_INSTRUCTION);
    expect(splitAgentKitMessageContext(prepared.displayMessage).message).toBe(message.trim());
    expect(splitAgentKitMessageContext(prepareEnglishAgentRequest({ message, displayMessage: "Original request" }).displayMessage).message).toBe("Original request");
  });

  it("wires the request hook and English/brief-card instructions into the actual chat plugin", () => {
    expect(options.prepareRequest).toBe(prepareEnglishAgentRequest);
    expect(options.systemPrompt).toContain(ENGLISH_OUTPUT_INSTRUCTION);
    expect(options.systemPrompt).toContain("one or two sentences");
    expect(options.systemPrompt).toContain("Do not restate the card's step table, raw IDs");
  });

  it("requires the question and options before the turn-ending widget and accepts a typed answer after reload", () => {
    expect(options.systemPrompt).toContain("Before calling ask-question (which ends the turn)");
    expect(options.systemPrompt).toContain("state the actual question in one sentence and briefly list its option labels");
    expect(options.systemPrompt).toContain("plain-text answer as settling that question and continue the blocked work without asking it again");
    expect(options.systemPrompt).toContain("clarification requirement takes precedence over the run-card summary limit");
  });

  it("adds English title guidance before Core's 500-character cutoff without changing model selection or auth headers", async () => {
    const event = { req: new Request("http://localhost:8080/_agent-native/agent-chat/generate-title", {
      method: "POST", headers: { "content-type": "application/json", cookie: "test-session" },
      body: JSON.stringify({ message: "批发咨询".repeat(300), model: "configured-model", engine: "ai-sdk:openai" }),
    }) };
    await prepareEnglishChatTitle(event);
    const body = await event.req.json();
    expect(body.message.slice(0, 500)).toContain(ENGLISH_TITLE_INSTRUCTION);
    expect(body).toMatchObject({ model: "configured-model", engine: "ai-sdk:openai" });
    expect(event.req.headers.get("cookie")).toBe("test-session");
    expect(titleMiddleware).toBeDefined();
  });

  it("leaves other endpoints and invalid title requests for Core to handle", async () => {
    for (const [path, body] of [["/_agent-native/agent-chat", { message: "Hello" }], ["/_agent-native/agent-chat/generate-title", { message: 7 }]]) {
      const event = { req: new Request(`http://localhost:8080${path}`, { method: "POST", body: JSON.stringify(body) }) };
      const original = event.req;
      await prepareEnglishChatTitle(event);
      expect(event.req).toBe(original);
      expect(await event.req.json()).toEqual(body);
    }
  });

  it("passes the modified title body to a downstream H3 route", async () => {
    const app = new H3();
    app.use(titleMiddleware);
    app.post("/_agent-native/agent-chat/generate-title", (event) => event.req.json());
    const response = await app.request("http://localhost:8080/_agent-native/agent-chat/generate-title", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Wholesale inquiry" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: ENGLISH_TITLE_INSTRUCTION + "Wholesale inquiry" });
  });
});
