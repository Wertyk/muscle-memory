import {
  readAppStateForCurrentTab,
  writeAppStateForCurrentTab,
} from "@agent-native/core/application-state";
import { GetHandlingStats, success } from "@muscle-memory/shop-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import navigate from "../actions/navigate";
import viewScreen from "../actions/view-screen";
import * as composition from "./composition";
import { createShopDemoData } from "./db/shop-demo-data";

vi.mock("@agent-native/core/application-state", () => ({
  readAppStateForCurrentTab: vi.fn(),
  writeAppStateForCurrentTab: vi.fn(),
}));
const data = createShopDemoData();
const request = data.requests[0]!;
const state: Record<string, Record<string, unknown>> = {};
let useCases: ReturnType<typeof composition.createShopUseCases>;
beforeEach(() => {
  for (const key of Object.keys(state)) delete state[key];
  vi.mocked(readAppStateForCurrentTab).mockImplementation(
    async (key) => state[key] ?? null,
  );
  useCases = {
    getRequest: { execute: vi.fn(async () => success(request)) },
    getRequestActivity: {
      execute: vi.fn(async () =>
        success([
          { id: request.id, at: request.createdAt, kind: "request_received" },
        ]),
      ),
    },
    getCustomer: {
      execute: vi.fn(async () =>
        success(data.customers.find((item) => item.id === request.customerId)!),
      ),
    },
    getOrder: {
      execute: vi.fn(async () =>
        success(data.orders.find((item) => item.id === request.orderId)!),
      ),
    },
    getShipmentStatus: {
      execute: vi.fn(async () =>
        success({ orderStatus: "delivered", shipment: null }),
      ),
    },
    listRequests: { execute: vi.fn(async () => success([request])) },
  } as unknown as typeof useCases;
  vi.spyOn(composition, "getShopUseCases").mockReturnValue(useCases);
  vi.spyOn(composition, "getCurrentDemonstration").mockResolvedValue(null);
  vi.spyOn(composition, "getRequestIntake").mockReturnValue({
    processing: { list: vi.fn(async () => []) },
  } as unknown as ReturnType<typeof composition.getRequestIntake>);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("agent workspace context", () => {
  it("reads run detail and filtered Runs context through the existing repository", async () => {
    const run = { id: "run_screen" };
    const get = vi.fn(async () => run);
    const list = vi.fn(async () => [run]);
    vi.spyOn(composition, "getRecipeUseCases").mockReturnValue({ runs: { get, list } } as unknown as ReturnType<typeof composition.getRecipeUseCases>);
    state.navigation = { view: "run", runId: run.id };
    expect(await viewScreen.run({}, { caller: "tool" })).toMatchObject({ run });
    expect(get).toHaveBeenCalledExactlyOnceWith(run.id);
    state.navigation = { view: "runs", path: "/runs" };
    state.__url__ = { searchParams: { status: "awaiting_approval", requestId: "req_0001", mode: "execute" } };
    expect(await viewScreen.run({}, { caller: "tool" })).toMatchObject({ activeFilters: state.__url__.searchParams, runs: [run] });
    expect(list).toHaveBeenCalledExactlyOnceWith(state.__url__.searchParams);
    await navigate.run({ view: "run", runId: run.id }, { caller: "tool" });
    expect(writeAppStateForCurrentTab).toHaveBeenCalledWith("navigate", expect.objectContaining({ view: "run", runId: run.id }));
  });
  it("reads the dashboard through the same scoped stats query as the UI action", async () => {
    state.navigation = { view: "dashboard", path: "/dashboard" };
    const query = new GetHandlingStats({ read: async () => ({ samples: [], pendingApprovals: 0, activeRecipes: 0 }) });
    vi.spyOn(composition, "getHandlingStats").mockReturnValue(query);
    const context = { caller: "tool" as const, userEmail: "operator@example.test", orgId: "shop" };
    expect(await viewScreen.run({}, context)).toMatchObject({ navigation: state.navigation, handlingStats: await query.execute() });
    expect(composition.getHandlingStats).toHaveBeenCalledExactlyOnceWith(context);
  });
  it("exposes fresh Recipe Studio data and preserves semantic recipe navigation", async () => {
    const list = vi.fn(async () => [{ id: "recipe_care", status: "draft" }]);
    const get = vi.fn(async () => ({
      recipe: { id: "recipe_care" },
      history: [],
    }));
    const getDraft = vi.fn(async () => ({
      recipeId: "recipe_care",
      revision: 3,
      content: {},
      ambiguities: [],
      issues: [],
    }));
    vi.spyOn(composition, "getRecipeStudio").mockReturnValue({
      list,
      get,
      getDraft,
    } as unknown as ReturnType<typeof composition.getRecipeStudio>);
    const context = {
      caller: "tool" as const,
      userEmail: "operator@example.test",
    };
    state.navigation = { view: "recipes", path: "/recipes" };
    expect(await viewScreen.run({}, context)).toMatchObject({
      recipes: [{ id: "recipe_care" }],
    });
    state.navigation = {
      view: "recipe",
      recipeId: "recipe_care",
      path: "/recipes/recipe_care",
    };
    expect(await viewScreen.run({}, context)).toMatchObject({
      recipe: { recipe: { id: "recipe_care" } },
      draft: { revision: 3 },
    });
    expect(getDraft).toHaveBeenCalledWith("recipe_care");
    expect(composition.getRecipeStudio).toHaveBeenCalledWith(context);
    await navigate.run({ view: "recipe", recipeId: "recipe_care" }, context);
    expect(writeAppStateForCurrentTab).toHaveBeenCalledWith(
      "navigate",
      expect.objectContaining({ view: "recipe", recipeId: "recipe_care" }),
    );
  });
  it("exposes processing and Teach context together for the current request", async () => {
    state.navigation = { view: "request", requestId: request.id };
    const context = {
      caller: "frontend" as const,
      userEmail: "operator@example.test",
    };
    const processing = {
      requestId: request.id,
      runId: "run_pending",
      state: "awaiting_approval" as const,
      matchReason: "matched" as const,
      tokens: { input: 0, output: 0 },
    };
    vi.mocked(composition.getRequestIntake().processing.list).mockResolvedValue(
      [processing],
    );
    vi.mocked(composition.getCurrentDemonstration).mockResolvedValue({
      id: "demo_context",
      subjectId: request.id,
      scope: {
        userId: context.userEmail,
        workspaceId: "shop",
        sessionId: "tab",
      },
      references: {},
      trigger: {},
      status: "recording",
      startedAt: 1,
      stoppedAt: null,
      incompleteReason: null,
      nextSequence: 1,
      pending: [],
      steps: [],
    });
    expect(await viewScreen.run({}, context)).toMatchObject({
      request,
      processing,
      demonstration: {
        id: "demo_context",
        status: "recording",
        stepCount: 0,
        incompleteReason: null,
      },
    });
    expect(composition.getCurrentDemonstration).toHaveBeenCalledWith(
      request.id,
      context,
    );
  });
  it("mirrors the processing filter and fresh processing records visible in the inbox", async () => {
    state.navigation = { view: "inbox", path: "/inbox" };
    state.__url__ = {
      searchParams: { status: "open", processing: "with_agent" },
    };
    const row = {
      requestId: request.id,
      runId: "run_test",
      state: "with_agent" as const,
      matchReason: "no_match" as const,
      tokens: { input: 0, output: 0 },
    };
    vi.mocked(composition.getRequestIntake().processing.list).mockResolvedValue(
      [row],
    );
    expect(await viewScreen.run({}, { caller: "tool" })).toMatchObject({
      activeFilters: { status: "open", processing: "with_agent" },
      requests: [request],
      processing: [row],
    });
    state.__url__.searchParams = { processing: "done" };
    expect(await viewScreen.run({}, { caller: "tool" })).toMatchObject({
      requests: [],
      processing: [],
    });
  });
  it("reads fresh selected-request details through the existing shop use-cases", async () => {
    state.navigation = {
      view: "request",
      path: `/requests/${request.id}`,
      requestId: request.id,
    };
    state.selection = {
      kind: "request",
      requestId: request.id,
      id: request.id,
    };
    const screen = await viewScreen.run({}, { caller: "tool" });
    expect(screen).toMatchObject({
      navigation: state.navigation,
      selection: state.selection,
      request,
      customer: { id: request.customerId },
      order: { id: request.orderId },
      shipment: { shipment: null },
    });
    expect(useCases.getRequest.execute).toHaveBeenCalledExactlyOnceWith({
      requestId: request.id,
    });
    expect(useCases.getOrder.execute).toHaveBeenCalledExactlyOnceWith({
      orderId: request.orderId,
    });
  });
  it("uses inbox URL filters and ignores stale request selection when choosing a view", async () => {
    state.navigation = { view: "inbox", path: "/inbox" };
    state.selection = { requestId: request.id };
    state.__url__ = { searchParams: { status: "open", type: "return" } };
    expect(await viewScreen.run({}, { caller: "tool" })).toMatchObject({
      activeFilters: { status: "open", type: "return" },
      requests: [request],
    });
    expect(useCases.listRequests.execute).toHaveBeenCalledExactlyOnceWith({
      status: "open",
      type: "return",
    });
    expect(useCases.getRequest.execute).not.toHaveBeenCalled();
  });
  it("returns a useful snapshot for inquiries without orders and rejects invalid ids", async () => {
    state.navigation = { view: "request", requestId: request.id };
    vi.mocked(useCases.getRequest.execute).mockResolvedValue(
      success({ ...request, orderId: null }),
    );
    const screen = await viewScreen.run({}, { caller: "tool" });
    expect(screen).toHaveProperty("customer");
    expect(screen).not.toHaveProperty("order");
    state.navigation.requestId = "../../not-a-request";
    await expect(viewScreen.run({}, { caller: "tool" })).rejects.toThrow();
  });
  it("writes a one-shot semantic request navigation command to the current tab", async () => {
    await navigate.run(
      { view: "request", requestId: request.id },
      { caller: "tool" },
    );
    expect(writeAppStateForCurrentTab).toHaveBeenCalledWith(
      "navigate",
      expect.objectContaining({
        view: "request",
        requestId: request.id,
        _writeId: expect.any(String),
      }),
    );
  });
});
