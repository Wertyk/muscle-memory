import { defineAction } from "@agent-native/core/action";
import { structuredRequestFieldsSchema } from "@muscle-memory/shop-domain";
import { z } from "zod";

import { getTeachUseCases } from "../server/composition.js";
import { shopId } from "../server/shop-action-contracts.js";
import { jsonContainerInput } from "../server/action-input.js";
import {
  demonstrationSchema,
  teachErrors,
  teachOperation,
} from "../server/teach-action-contracts.js";

export default defineAction({
  description:
    "Start Teach on the request open in this operator's browser tab. Captures scoped shop reads and mutations until stopped. Free text needs complete confirmed fields or a saved intake extraction; Teach never calls a model.",
  schema: z.object({
    requestId: shopId("request"),
    fields: jsonContainerInput(structuredRequestFieldsSchema, "fields").optional(),
  }),
  outputSchema: demonstrationSchema,
  errors: teachErrors,
  run: (input, context) =>
    teachOperation(() => getTeachUseCases().start(input, context)),
});
