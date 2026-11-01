import { randomBytes } from "node:crypto";
import {
  CreateReplacementOrder, Escalate, GenerateReturnLabel, GetCustomer, GetOrder,
  GetRequest, GetShipmentStatus, ID_PREFIXES, IssueRefund, ListRequests, SendReply,
  SetRequestStatus, TagRequest, UpdateShippingAddress, type ShopDependencies,
} from "@muscle-memory/shop-domain";
import { getDb } from "./db/index.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import type { TraceCapture } from "./infra/traced.js";

/** TASK-9 supplies recording/session policy here without changing shop actions. */
export const shopTraceCapture: TraceCapture = { recording: async () => null };

export function createShopUseCases(deps: ShopDependencies) {
  return {
    listRequests: new ListRequests(deps.shop),
    getRequest: new GetRequest(deps.shop),
    getOrder: new GetOrder(deps.shop),
    getCustomer: new GetCustomer(deps.shop),
    getShipmentStatus: new GetShipmentStatus(deps.shop),
    issueRefund: new IssueRefund(deps),
    sendReply: new SendReply(deps),
    tagRequest: new TagRequest(deps),
    setRequestStatus: new SetRequestStatus(deps),
    escalate: new Escalate(deps),
    createReplacementOrder: new CreateReplacementOrder(deps),
    updateShippingAddress: new UpdateShippingAddress(deps),
    generateReturnLabel: new GenerateReturnLabel(deps),
  };
}

let shopUseCases: ReturnType<typeof createShopUseCases> | undefined;

/** Lazy so action discovery never opens a database. */
export function getShopUseCases() {
  return shopUseCases ??= createShopUseCases({
    shop: new DrizzleShopRepository(getDb()),
    clock: { now: () => new Date().toISOString() },
    ids: { next: (kind) => `${ID_PREFIXES[kind]}_${randomBytes(8).toString("hex")}` },
  });
}
