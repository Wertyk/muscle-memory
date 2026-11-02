import { randomBytes } from "node:crypto";

import type { ActionRunContext } from "@agent-native/core/action";
import {
  BacktestRecipe,
  Demonstrations,
  DraftRecipeFromDemonstration,
  MatchRequest,
  RecipeStudio,
  RunRecipe,
  type RunRecipeDependencies,
  type TextExtractor,
} from "@muscle-memory/recipe-engine";
import {
  ClassifyRequest,
  CreateRequest,
  ValidateRequestFields,
  CreateReplacementOrder,
  Escalate,
  GenerateReturnLabel,
  GetCustomer,
  GetOrder,
  GetHandlingStats,
  GetRequest,
  GetRequestActivity,
  GetShipmentStatus,
  ID_PREFIXES,
  IssueRefund,
  ListRequests,
  SendReply,
  SetRequestStatus,
  TagRequest,
  UpdateShippingAddress,
  type ShopDependencies,
} from "@muscle-memory/shop-domain";

import { getDb, type ShopDb } from "./db/index.js";
import { DrizzleAgentHandoff } from "./infra/agent-handoff.js";
import { CompleteTextExtractor } from "./infra/complete-text-extraction.js";
import { DemoIntake } from "./infra/demo-intake.js";
import { RecipeActionInvoker } from "./infra/recipe-action-invoker.js";
import { DrizzleRecipeCatalog } from "./infra/recipe-catalog.js";
import { DrizzleRecipeStudioStore } from "./infra/recipe-studio-store.js";
import { RegistryActionInvoker } from "./infra/registry-action-invoker.js";
import { RequestIntake } from "./infra/request-intake.js";
import { DrizzleRequestProcessing } from "./infra/request-processing.js";
import { DrizzleRunRepository } from "./infra/run-repository.js";
import { ShopDemonstrations } from "./infra/shop-demonstrations.js";
import { ShopHistoricalCaseSource } from "./infra/shop-historical-cases.js";
import { ShopMutationNormalizer } from "./infra/shop-mutation-normalizer.js";
import { ShopRecipeBacktests } from "./infra/shop-recipe-backtests.js";
import { AgentRequestUsage } from "./infra/agent-request-usage.js";
import { DrizzleHandlingStats } from "./infra/handling-stats.js";
import { DrizzleShopRepository } from "./infra/shop-repository.js";
import { ShopRequestExtractor } from "./infra/shop-request-extractor.js";
import { createShopTraceCapture } from "./infra/shop-trace-capture.js";
import {
  demonstrationOwner,
  demonstrationScope,
} from "./infra/teach-session.js";
import { DrizzleTraceStore } from "./infra/trace-store.js";
import { shopResult } from "./shop-action-contracts.js";

export function createRecipeStudio(db: ShopDb, context?: ActionRunContext) {
  return new RecipeStudio(
    new DrizzleRecipeStudioStore(db, demonstrationOwner(context)),
    () => `ver_${randomBytes(8).toString("hex")}`,
  );
}
export function getRecipeStudio(context?: ActionRunContext) {
  return createRecipeStudio(getDb(), context);
}
export function createTeachUseCases(db: ShopDb) {
  const demonstrations = new Demonstrations(
    new DrizzleTraceStore(db),
    { now: Date.now },
    () => `demo_${randomBytes(8).toString("hex")}`,
  );
  const shop = new DrizzleShopRepository(db);
  return new ShopDemonstrations(
    demonstrations,
    db,
    shop,
    new ValidateRequestFields(shop),
  );
}
export function getTeachUseCases() {
  return createTeachUseCases(getDb());
}
export function createDraftRecipeUseCases(
  db: ShopDb,
  registry = new RegistryActionInvoker(),
) {
  return new DraftRecipeFromDemonstration({
    traces: new DrizzleTraceStore(db),
    recipes: new DrizzleRecipeCatalog(db),
    actions: registry,
    nextId: (kind) =>
      `${kind === "version" ? "ver" : "recipe"}_${randomBytes(8).toString("hex")}`,
  });
}
export function getDraftRecipeUseCases() {
  return createDraftRecipeUseCases(getDb());
}
export const shopTraceCapture = createShopTraceCapture(
  () => getTeachUseCases().demonstrations,
);
shopTraceCapture.succeeded = (action, context) => new AgentRequestUsage(getDb()).succeeded(action, context);

export function getHandlingStats(context?: ActionRunContext) {
  const owner = demonstrationOwner(context);
  if (!owner) throw new Error("Sign in to read handling measurements.");
  return new GetHandlingStats(new DrizzleHandlingStats(getDb(), owner));
}

export function createShopUseCases(deps: ShopDependencies) {
  return {
    createRequest: new CreateRequest(deps),
    classifyRequest: new ClassifyRequest(deps),
    validateRequestFields: new ValidateRequestFields(deps.shop),
    listRequests: new ListRequests(deps.shop),
    getRequest: new GetRequest(deps.shop),
    getRequestActivity: new GetRequestActivity(deps.shop),
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
    ids: {
      next: (kind) => `${ID_PREFIXES[kind]}_${randomBytes(8).toString("hex")}`,
    },
  };
}

/** Lazy so action discovery never opens a database. */
export function getShopUseCases() {
  return (shopUseCases ??= createShopUseCases(shopDependencies(getDb())));
}

/** All framework adapters are wired here; overrides keep integration tests offline. */
export function createRecipeUseCases(
  db: ShopDb,
  options: {
    context?: ActionRunContext;
    registry?: RegistryActionInvoker;
    extractor?: TextExtractor;
    ids?: RunRecipeDependencies["ids"];
  } = {},
) {
  const runs = new DrizzleRunRepository(db);
  return {
    runs,
    runRecipe: new RunRecipe({
      runs,
      actions: new RecipeActionInvoker(
        options.registry ?? new RegistryActionInvoker(),
        options.context,
      ),
      extractor: options.extractor ?? new CompleteTextExtractor(),
      handoff: new DrizzleAgentHandoff(db, (tx, input) =>
        shopResult(
          new Escalate(shopDependencies(tx as unknown as ShopDb)).execute(
            input,
          ),
        ),
      ),
      clock: { now: Date.now },
      ids: options.ids ?? {
        next: () => `run_${randomBytes(8).toString("hex")}`,
      },
    }),
  };
}

export function getRecipeUseCases(context?: ActionRunContext) {
  return createRecipeUseCases(getDb(), {
    context: context ?? { caller: "automation" },
  });
}

export function createRecipeBacktests(
  db: ShopDb,
  options: Parameters<typeof createRecipeUseCases>[1] = {},
) {
  return new ShopRecipeBacktests(db, () => {
    const extractor = options.extractor ?? new CompleteTextExtractor();
    const validator = new ValidateRequestFields(new DrizzleShopRepository(db));
    const cases = new ShopHistoricalCaseSource(
      db,
      (request) =>
        new ShopRequestExtractor(extractor, validator, request.customerId, { orderId: request.orderId, shop: new DrizzleShopRepository(db) }),
    );
    return {
      cases,
      backtester: new BacktestRecipe({
        cases,
        normalizer: new ShopMutationNormalizer(),
        actions: new RecipeActionInvoker(
          options.registry ?? new RegistryActionInvoker(),
          options.context,
        ),
        extractor,
        clock: { now: Date.now },
        ids: options.ids ?? {
          next: () => `run_${randomBytes(8).toString("hex")}`,
        },
      }),
    };
  });
}

export function getRecipeBacktests(context?: ActionRunContext) {
  return createRecipeBacktests(getDb(), {
    context: context ?? { caller: "automation" },
  });
}

export function createRequestIntake(
  db: ShopDb,
  options: Parameters<typeof createRecipeUseCases>[1] = {},
) {
  const shop = createShopUseCases(shopDependencies(db));
  const catalog = new DrizzleRecipeCatalog(db);
  const extractor = options.extractor ?? new CompleteTextExtractor();
  const intake = new RequestIntake(db, {
    create: (input) => shopResult(shop.createRequest.execute(input)),
    classify: (requestId, type) =>
      shopResult(shop.classifyRequest.execute({ requestId, type })),
    get: (id) => new DrizzleShopRepository(db).getRequest(id),
    matcher: (request) =>
      new MatchRequest({
        recipes: catalog,
        extractor: new ShopRequestExtractor(
          extractor,
          shop.validateRequestFields,
          request.customerId,
          { orderId: request.orderId, shop: new DrizzleShopRepository(db) },
        ),
      }),
    executor: (runId) =>
      createRecipeUseCases(db, {
        ...options,
        extractor,
        ids: { next: () => runId },
      }),
    nextRunId: () =>
      options.ids?.next("run") ?? `run_${randomBytes(8).toString("hex")}`,
  });
  return {
    intake,
    catalog,
    processing: new DrizzleRequestProcessing(db),
    demo: new DemoIntake(intake),
  };
}

export function getRequestIntake(context?: ActionRunContext) {
  return createRequestIntake(getDb(), {
    context: context ?? { caller: "automation" },
  });
}

export function getCurrentDemonstration(
  requestId: string,
  context?: ActionRunContext,
) {
  const scope = demonstrationScope(context);
  return scope
    ? getTeachUseCases().demonstrations.current(scope, requestId)
    : Promise.resolve(null);
}
