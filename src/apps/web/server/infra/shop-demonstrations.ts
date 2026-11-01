import type { ActionRunContext } from "@agent-native/core/action";
import type { Demonstrations, JsonObject } from "@muscle-memory/recipe-engine";
import { buildRequestTrigger } from "@muscle-memory/recipe-engine";
import {
  structuredRequestFieldsSchema,
  type RequestId,
  type StructuredRequestFields,
  type ValidateRequestFields,
} from "@muscle-memory/shop-domain";
import { eq } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import { requestProcessing } from "../db/schema.js";
import { shopResult } from "../shop-action-contracts.js";
import type { DrizzleShopRepository } from "./shop-repository.js";
import {
  demonstrationOwner,
  demonstrationScope,
  teachNavigation,
} from "./teach-session.js";

export class TeachInputError extends Error {}
/** Translate shop snapshots to the generic engine, without recording setup reads. */
export class ShopDemonstrations {
  constructor(
    readonly demonstrations: Demonstrations,
    private readonly db: ShopDb,
    private readonly shop: DrizzleShopRepository,
    private readonly validate: ValidateRequestFields,
  ) {}
  async start(
    input: {
      requestId: RequestId;
      fields?: StructuredRequestFields | undefined;
    },
    context?: ActionRunContext,
  ) {
    const scope = this.scope(context);
    const navigation = await teachNavigation();
    if (
      navigation?.view !== "request" ||
      navigation.requestId !== input.requestId
    )
      throw new TeachInputError(
        "Open this request in the current tab before starting Teach.",
      );
    const request = await this.shop.getRequest(input.requestId);
    if (!request) throw new TeachInputError("Request not found.");
    let fields: StructuredRequestFields;
    if (request.content.source === "structured")
      fields = request.content.fields;
    else {
      const [saved] = await this.db
        .select()
        .from(requestProcessing)
        .where(eq(requestProcessing.requestId, request.id));
      const {
        requestId: _requestId,
        customerId: _customerId,
        subject: _subject,
        ...savedFields
      } = saved?.match?.trigger ?? {};
      const parsed = structuredRequestFieldsSchema.safeParse(
        input.fields ?? savedFields,
      );
      if (!parsed.success)
        throw new TeachInputError(
          "Confirm complete request fields to teach this free-text request. No extraction runs from Teach.",
        );
      fields = await shopResult(
        this.validate.execute({
          customerId: request.customerId,
          fields: parsed.data,
        }),
      );
      if (
        request.orderId &&
        ("orderId" in fields ? fields.orderId : null) !== request.orderId
      )
        throw new TeachInputError(
          "Request fields must refer to this request’s linked order.",
        );
    }
    const orderId = "orderId" in fields ? fields.orderId : request.orderId;
    return this.demonstrations.start({
      scope,
      subjectId: request.id,
      references: {
        requestId: request.id,
        customerId: request.customerId,
        ...(orderId ? { orderId } : {}),
      },
      trigger: buildRequestTrigger(fields as unknown as JsonObject, {
        requestId: request.id,
        customerId: request.customerId,
        subject: request.subject,
      }),
    });
  }
  scope(context?: ActionRunContext) {
    const scope = demonstrationScope(context);
    if (!scope)
      throw new TeachInputError(
        "Teach requires a signed-in operator and a current browser tab.",
      );
    return scope;
  }
  get(
    input: {
      demonstrationId?: string | undefined;
      requestId?: string | undefined;
    },
    context?: ActionRunContext,
  ) {
    const owner = demonstrationOwner(context);
    if (!owner) throw new TeachInputError("Sign in to read a demonstration.");
    if (input.demonstrationId)
      return this.demonstrations.get(owner, input.demonstrationId);
    return this.demonstrations.current(this.scope(context), input.requestId!);
  }
  finish(id: string, cancel: boolean, context?: ActionRunContext) {
    return this.demonstrations.finish(this.scope(context), id, cancel);
  }
}
