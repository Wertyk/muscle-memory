// Opt-in smoke support. No proof UI or renderer is registered by the product.
import assert from "node:assert/strict";

import { AgentKitClient } from "@agent-native/agentkit";
import type {
  AgentToolCall,
  AgentWidget,
} from "@agent-native/agentkit/protocol";
import { AgentKitProvider } from "@agent-native/toolkit/app/agentkit";
import {
  AgentKitActionWidget,
  registerActionChatRenderer,
} from "@agent-native/toolkit/app/chat";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

export async function renderProofCard(
  tool: AgentToolCall,
  widget: AgentWidget,
): Promise<string> {
  const client = new AgentKitClient({
    transport: {
      async startRun() {
        throw new Error("Offline renderer cannot start a model run.");
      },
      async *subscribeToRun() {},
      async cancelRun() {},
      async getThreadSnapshot() {
        return {
          id: "thread_proof",
          createdAt: "2026-11-02T00:00:00Z",
          updatedAt: "2026-11-02T00:00:00Z",
          messages: [],
          toolCalls: [tool],
        };
      },
    },
  });
  await client.loadThread("thread_proof");
  const unregister = registerActionChatRenderer({
    id: "muscle-memory.task3-proof",
    renderer: "muscle-memory.task3-proof",
    Component: ({ context }) => {
      const result = context.resultJson as {
        label?: string;
        actionName?: string;
      } | null;
      return (
        <article data-task3-card="rendered">
          <h3>Action result</h3>
          <p>{result?.label}</p>
          <small>{result?.actionName}</small>
        </article>
      );
    },
  });
  try {
    return renderToStaticMarkup(
      <AgentKitProvider controller={client} threadId="thread_proof">
        <AgentKitActionWidget value={widget} threadId="thread_proof" />
      </AgentKitProvider>,
    );
  } finally {
    unregister();
    await client.dispose();
  }
}

/** A DOM click calls the unmodified client helper over real local HTTP.
 * Only the browser network boundary supplies the test session cookie. */
export async function proveFrontendTrace(baseUrl: string, cookie: string) {
  const dom = new Window({ url: `${baseUrl}/home` });
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return originalFetch(new URL(String(input), baseUrl), { ...init, headers });
  };
  try {
    const { callAction, writeClientAppState } =
      await import("@agent-native/core/client/hooks");
    await writeClientAppState("navigation", {
      view: "request",
      requestId: "req_0007",
      path: "/home",
    });
    await callAction("task3-proof-control", { operation: "on" });
    const button = dom.document.createElement("button");
    button.textContent = "Apply synthetic tag";
    dom.document.body.append(button);
    const clicked = new Promise<unknown>((resolve, reject) => {
      button.onclick = () => {
        void callAction("task3-proof-mutate", { label: "ui-on" }).then(
          resolve,
          reject,
        );
      };
    });
    button.click();
    await clicked;
    const on = (await callAction("task3-proof-control", {
      operation: "off",
    })) as { steps: Array<Record<string, unknown>> };
    assert.equal(on.steps.length, 1);
    assert.equal(on.steps[0]?.caller, "frontend");
    assert.deepEqual(on.steps[0]?.input, { label: "ui-on" });
    assert.deepEqual(on.steps[0]?.navigation, {
      view: "request",
      requestId: "req_0007",
      path: "/home",
    });
    assert.deepEqual(on.steps[0]?.output, {
      label: "ui-on",
      eventsHandled: 1,
      actionName: "task3-proof-mutate",
    });
    const offClick = new Promise<unknown>((resolve, reject) => {
      button.onclick = () => {
        void callAction("task3-proof-mutate", { label: "ui-off" }).then(
          resolve,
          reject,
        );
      };
    });
    button.click();
    await offClick;
    const off = (await callAction("task3-proof-control", {
      operation: "status",
    })) as { steps: unknown[] };
    assert.equal(off.steps.length, 1);
    return {
      recorded: on.steps.length,
      afterRecordingOff: off.steps.length,
      caller: "frontend",
      navigation: "req_0007",
      transport: "DOM click -> callAction -> local HTTP",
    };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
}
