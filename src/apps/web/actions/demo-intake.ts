import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRequestIntake, shopTraceCapture } from "../server/composition.js";
import { requestSchema } from "../server/shop-action-contracts.js";
import { intakeErrors, intakeOperation } from "../server/intake-action-contracts.js";
import { traced } from "../server/infra/traced.js";

export default defineAction({
  description: "Inject five scripted support requests through real request.created intake. Requires TASK-6 seeded customers/orders. Uses current active recipes; records real refunds/replies/approvals/handoffs. Repeating creates five more requests and effects.",
  schema: z.object({}).strict(),
  outputSchema: z.array(requestSchema),
  errors: intakeErrors,
  run: traced("demo-intake", (_input, context) => intakeOperation(() => getRequestIntake(context).demo.execute()), shopTraceCapture),
});
