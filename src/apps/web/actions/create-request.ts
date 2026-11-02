import { defineAction } from "@agent-native/core/action";
import { createRequestInputSchema } from "@muscle-memory/shop-domain";
import { getRequestIntake, shopTraceCapture } from "../server/composition.js";
import { requestSchema } from "../server/shop-action-contracts.js";
import { intakeErrors, intakeOperation } from "../server/intake-action-contracts.js";
import { traced } from "../server/infra/traced.js";
import { jsonContainerInput } from "../server/action-input.js";

export default defineAction({
  description: "Create a customer support request from structured shop fields or free text. Await request.created matching/execution before returning; query list-request-processing for run/state. Free text uses one cheap extraction call.",
  schema: createRequestInputSchema.extend({ content: jsonContainerInput(createRequestInputSchema.shape.content, "content") }),
  outputSchema: requestSchema,
  errors: intakeErrors,
  run: traced("create-request", (input, context) => intakeOperation(() => getRequestIntake(context).intake.create(input)), shopTraceCapture),
});
