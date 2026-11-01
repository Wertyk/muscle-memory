import { defineAction } from "@agent-native/core/action";
import { readAppStateForCurrentTab } from "@agent-native/core/application-state";
import { REQUEST_STATUSES, REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";

import { getRequestIntake, getShopUseCases } from "../server/composition.js";
import { PROCESSING_STATES } from "../shared/request-processing.js";
import { shopId, shopResult } from "../server/shop-action-contracts.js";

export default defineAction({
  description:
    "Read the current tab's navigation and selected request, with fresh request/customer/order/shipment details or the filtered inbox. Use shop actions to make changes; navigate with view=inbox or view=request and requestId.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppStateForCurrentTab("navigation");
    const selection = await readAppStateForCurrentTab("selection");
    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    if (selection) screen.selection = selection;
    if (
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
      screen.processing = (await getRequestIntake().processing.list([request.id]))[0] ?? null;
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
        (value) => value === (params.success ? params.data.processing : undefined),
      );
      const rows = await getRequestIntake().processing.list();
      screen.activeFilters = { ...filter, ...(processing ? { processing } : {}) };
      const requests = await shopResult(
        getShopUseCases().listRequests.execute(filter),
      );
      const visible = requests.filter((request) => !processing || rows.some((row) => row.requestId === request.id && row.state === processing));
      screen.requests = visible;
      screen.processing = rows.filter((row) => visible.some((request) => request.id === row.requestId));
    }
    return Object.keys(screen).length
      ? screen
      : "No application state found. Is the app running?";
  },
});
