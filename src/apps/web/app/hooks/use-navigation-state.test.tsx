import { setClientAppState } from "@agent-native/core/client/hooks";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandPathForNavigation,
  navigationStateForPath,
  pathForCommand,
  useNavigationState,
} from "./use-navigation-state";

vi.mock("@agent-native/core/client/navigation", () => ({
  useAgentRouteState: vi.fn(),
}));
vi.mock("@agent-native/core/client/hooks", () => ({
  setClientAppState: vi.fn(async () => null),
}));
vi.mock("@/lib/tab-id", () => ({ TAB_ID: "test-tab" }));
vi.mock("@agent-native/core/client/api-path", () => ({
  appBasePath: () => "",
  appPathFromLocalRoute: (path: string) => path,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("shop route state", () => {
  it("maps direct links and semantic agent commands to the same shop routes", () => {
    expect(navigationStateForPath("/inbox")).toEqual({
      view: "inbox",
      path: "/inbox",
      publicPath: "/inbox",
    });
    expect(navigationStateForPath("/requests/req_0007")).toMatchObject({
      view: "request",
      requestId: "req_0007",
    });
    expect(pathForCommand({ view: "request", requestId: "req_0007" })).toBe(
      "/requests/req_0007",
    );
    expect(pathForCommand({ view: "inbox" })).toBe("/inbox");
    expect(navigationStateForPath("/runs/run_0007")).toMatchObject({ view: "run", runId: "run_0007" });
    expect(navigationStateForPath("/runs").view).toBe("runs");
    expect(pathForCommand({ view: "run", runId: "run_0007" })).toBe("/runs/run_0007");
    expect(pathForCommand({ view: "runs" })).toBe("/runs");
    expect(commandPathForNavigation({ path: "/inbox?status=pending" })).toBe(
      "/inbox?status=pending",
    );
    expect(navigationStateForPath("/chat/thread-7")).toMatchObject({
      view: "chat",
      threadId: "thread-7",
    });
  });
  it("writes selected request ids per tab and clears them on leaving the request", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div");
    const root = createRoot(node);
    function Probe() {
      useNavigationState();
      const navigate = useNavigate();
      return <button onClick={() => navigate("/inbox")}>Back</button>;
    }
    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/requests/req_0007"]}>
            <Probe />
          </MemoryRouter>,
        );
      });
      expect(setClientAppState).toHaveBeenLastCalledWith(
        "selection:test-tab",
        { kind: "request", id: "req_0007", requestId: "req_0007" },
        { requestSource: "test-tab" },
      );
      await act(async () => {
        node.querySelector("button")!.click();
      });
      expect(setClientAppState).toHaveBeenLastCalledWith(
        "selection:test-tab",
        null,
        { requestSource: "test-tab" },
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});
