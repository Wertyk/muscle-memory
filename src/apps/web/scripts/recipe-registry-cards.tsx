// Mount the real saved AgentKit thread and registered cards; no fabricated tools.
import { AgentKitClient } from "@agent-native/agentkit";
import type { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import { AgentNativeI18nProvider } from "@agent-native/core/client/i18n";
import { AgentKitChat } from "@agent-native/toolkit/app/agentkit";
import { CoreAgentKitRoot } from "@agent-native/toolkit/app/chat/agentkit-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { i18nCatalog } from "../app/i18n/index.js";
import "../app/components/runs/RunChatCard.js";

export async function verifyRegistryCards(
  transport: ReturnType<typeof createAgentNativeAgentKitTransport>,
  authenticatedFetch: typeof fetch,
  threadId: string,
): Promise<number> {
  const dom = new Window({ url: `http://localhost:8095/chat/${threadId}` });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Event: dom.Event, CustomEvent: dom.CustomEvent, HTMLElement: dom.HTMLElement,
    Element: dom.Element, HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = authenticatedFetch;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const client = new AgentKitClient({ transport });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await client.loadThread(threadId);
    await act(async () => root.render(
      <AgentNativeI18nProvider catalog={i18nCatalog}>
        <QueryClientProvider client={query}>
          <MemoryRouter initialEntries={[`/chat/${threadId}`]}>
            <CoreAgentKitRoot controller={client} threadId={threadId} load="manual">
              <AgentKitChat composer={false} />
            </CoreAgentKitRoot>
          </MemoryRouter>
        </QueryClientProvider>
      </AgentNativeI18nProvider>,
    ));
    for (let attempt = 0; attempt < 100; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      const cards = [...document.querySelectorAll("[data-run-card]")];
      if (cards.length >= 2 && cards.every(card => card.querySelector(".run-status")?.textContent === "Completed")) return cards.length;
    }
    throw new Error("Saved live AgentKit thread did not render both completed run cards");
  } finally {
    await act(async () => root.unmount());
    query.clear();
    await client.dispose();
    globalThis.fetch = nativeFetch;
    dom.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
