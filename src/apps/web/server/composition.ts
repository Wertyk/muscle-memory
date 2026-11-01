import { randomBytes } from "node:crypto";
import type { ActionRunContext } from "@agent-native/core/action";
import { RunRecipe, type RunRecipeDependencies, type TextExtractor } from "@muscle-memory/recipe-engine";
import {
  CreateReplacementOrder, Escalate, GenerateReturnLabel, GetCustomer, GetOrder,
  GetRequest, GetShipmentStatus, ID_PREFIXES, IssueRefund, ListRequests, SendReply,
  SetRequestStatus, TagRequest, UpdateShippingAddress, type ShopDependencies,
} from "@muscle-memory/shop-domain";
import { getDb, type ShopDb } from "./db/index.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import type { TraceCapture } from "./infra/traced.js";
import { CompleteTextExtractor } from "./infra/complete-text-extraction.js";
import { DrizzleAgentHandoff } from "./infra/agent-handoff.js";
import { RecipeActionInvoker } from "./infra/recipe-action-invoker.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { DrizzleRunRepository } from "./infra/run-repository.js";
import { shopResult } from "./shop-action-contracts.js";

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

function shopDependencies(db: ShopDb): ShopDependencies {
  return {
    shop: new DrizzleShopRepository(db),
    clock: { now: () => new Date().toISOString() },
    ids: { next: (kind) => `${ID_PREFIXES[kind]}_${randomBytes(8).toString("hex")}` },
  };
}

/** Lazy so action discovery never opens a database. */
export function getShopUseCases() {
  return shopUseCases ??= createShopUseCases(shopDependencies(getDb()));
}

/** All framework adapters are wired here; overrides keep integration tests offline. */
export function createRecipeUseCases(db: ShopDb, options: {
  context?: ActionRunContext;
  registry?: RegistryActionInvoker;
  extractor?: TextExtractor;
  ids?: RunRecipeDependencies["ids"];
} = {}) {
  const runs = new DrizzleRunRepository(db);
  return {
    runs,
    runRecipe: new RunRecipe({
      runs,
      actions: new RecipeActionInvoker(options.registry ?? new RegistryActionInvoker(), options.context),
      extractor: options.extractor ?? new CompleteTextExtractor(),
      handoff: new DrizzleAgentHandoff(db, (tx, input) =>
        shopResult(new Escalate(shopDependencies(tx as unknown as ShopDb)).execute(input))),
      clock: { now: Date.now },
      ids: options.ids ?? { next: () => `run_${randomBytes(8).toString("hex")}` },
    }),
  };
}

export function getRecipeUseCases(context?: ActionRunContext) {
  return createRecipeUseCases(getDb(), {
    context: context ?? { caller: "automation" },
  });
}
