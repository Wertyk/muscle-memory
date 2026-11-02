import { readCorrections } from "../server/composition.js";
import { defineAction } from "@agent-native/core/action";
import { readAppStateForCurrentTab } from "@agent-native/core/application-state";
import { REQUEST_STATUSES, REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";

import {
  getRequestIntake,
  getRecipeStudio,
  getShopUseCases,
  getCurrentDemonstration,
  getRecipeUseCases,
  getHandlingStats,
} from "../server/composition.js";
import { shopId, shopResult } from "../server/shop-action-contracts.js";
import { runFiltersSchema } from "../server/recipe-action-contracts.js";
import { PROCESSING_STATES } from "../shared/request-processing.js";
import { RECIPE_BACKTEST_STATE, shownBacktestSchema } from "../shared/recipe-backtests.js";

export default defineAction({
  description:
    "Read the current tab's navigation and selected request, with fresh request/customer/order/shipment details or the filtered inbox. Use shop actions to make changes; navigate with view=inbox or view=request and requestId.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async (_input, context) => {
    const navigation = await readAppStateForCurrentTab("navigation");
    const selection = await readAppStateForCurrentTab("selection");
    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    if (selection) screen.selection = selection;
    if (navigation?.view === "run" && typeof navigation.runId === "string") {
      screen.corrections = await readCorrections(context, { runId: navigation.runId });
      screen.run = await getRecipeUseCases().runs.get(navigation.runId);
    } else if (navigation?.view === "runs") {
      const url = await readAppStateForCurrentTab("__url__");
      const filters = runFiltersSchema.parse(url?.searchParams ?? {});
      screen.activeFilters = filters;
      screen.runs = await getRecipeUseCases().runs.list(filters);
    } else if (
      navigation?.view === "request" &&
      typeof navigation.requestId === "string"
    ) {
      const useCases = getShopUseCases();
      const request = await shopResult(
        useCases.getRequest.execute({
          requestId: shopId("request").parse(navigation.requestId),
        }),
      );
      screen.request = request;
      screen.corrections = await readCorrections(context, { requestId: request.id });
      screen.processing =
        (await getRequestIntake().processing.list([request.id]))[0] ?? null;
      const demonstration = await getCurrentDemonstration(request.id, context);
      screen.demonstration = demonstration
        ? {
            id: demonstration.id,
            status: demonstration.status,
            stepCount: demonstration.steps.length,
            incompleteReason: demonstration.incompleteReason,
          }
        : null;
      screen.activity = await shopResult(
        useCases.getRequestActivity.execute({ requestId: request.id }),
      );
      screen.customer = await shopResult(
        useCases.getCustomer.execute({ customerId: request.customerId }),
      );
      if (request.orderId) {
        screen.order = await shopResult(
          useCases.getOrder.execute({ orderId: request.orderId }),
        );
        screen.shipment = await shopResult(
          useCases.getShipmentStatus.execute({ orderId: request.orderId }),
        );
      }
    } else if (navigation?.view === "dashboard") {
      screen.handlingStats = await getHandlingStats(context).execute();
    } else if (navigation?.view === "recipes") {
      screen.recipes = await getRecipeStudio(context).list();
    } else if (
      navigation?.view === "recipe" &&
      typeof navigation.recipeId === "string"
    ) {
      const detail = await getRecipeStudio(context).get(navigation.recipeId);
      screen.recipe = detail;
      screen.corrections = await readCorrections(context, { recipeId: navigation.recipeId });
      screen.draft = await getRecipeStudio(context).getDraft(
        navigation.recipeId,
      );
      const shown = shownBacktestSchema.safeParse(await readAppStateForCurrentTab(RECIPE_BACKTEST_STATE));
      screen.backtest = shown.success && shown.data.recipeId === navigation.recipeId &&
        shown.data.reports.every((report) => detail.history.some((entry) => entry.version.id === report.recipeVersionId))
        ? shown.data : null;
    } else if (navigation?.view === "inbox") {
      const url = await readAppStateForCurrentTab("__url__");
      const params = z
        .record(z.string(), z.unknown())
        .safeParse(url?.searchParams);
      const status = REQUEST_STATUSES.find(
        (value) => value === (params.success ? params.data.status : undefined),
      );
      const type = REQUEST_TYPES.find(
        (value) => value === (params.success ? params.data.type : undefined),
      );
      const filter = {
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      };
      const processing = PROCESSING_STATES.find(
        (value) =>
          value === (params.success ? params.data.processing : undefined),
      );
      const rows = await getRequestIntake().processing.list();
      screen.activeFilters = {
        ...filter,
        ...(processing ? { processing } : {}),
      };
      const requests = await shopResult(
        getShopUseCases().listRequests.execute(filter),
      );
      const visible = requests.filter(
        (request) =>
          !processing ||
          rows.some(
            (row) => row.requestId === request.id && row.state === processing,
          ),
      );
      screen.requests = visible;
      screen.processing = rows.filter((row) =>
        visible.some((request) => request.id === row.requestId),
      );
    }
    return Object.keys(screen).length
      ? screen
      : "No application state found. Is the app running?";
  },
});
