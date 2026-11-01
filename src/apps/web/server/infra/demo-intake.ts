import type { CreateRequestInput } from "@muscle-memory/shop-domain";
import type { RequestIntake } from "./request-intake.js";

/** Scripted inputs reference TASK-6's deterministic seed. No recipes are
 * installed or outcomes precomputed by demo intake. All effects are real. */
export const demoIntakeScript: readonly CreateRequestInput[] = [
  { customerId: "cus_0006", subject: "A chipped bowl", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1006", productId: "prd_0010", quantity: 1, description: "One bowl arrived chipped; please refund half its price.",
  } } },
  { customerId: "cus_0016", subject: "Broken mug handle", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1016", productId: "prd_0002", quantity: 1, description: "One mug handle broke in transit; please refund half its price.",
  } } },
  { customerId: "cus_0002", subject: "Where is my order?", content: { source: "free_text", text: "Could you check the shipment status of my order ord_1042?" } },
  { customerId: "cus_0001", subject: "Damaged serving platter", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1001", productId: "prd_0023", quantity: 1, description: "One large serving platter arrived cracked; please refund half its price.",
  } } },
  { customerId: "cus_0003", subject: "Wholesale inquiry", content: { source: "structured", fields: {
    type: "wholesale_inquiry", company: "Demo Clay Cafe", message: "Could you quote 60 mugs for our new cafe?",
  } } },
];

export class DemoIntake {
  constructor(private readonly intake: RequestIntake) {}
  async execute() {
    const requests = [];
    // Five independently durable requests; never hold executor effects in a
    // rollbackable shop transaction. Failure reports a partial batch honestly.
    for (const input of demoIntakeScript) requests.push(await this.intake.create(input));
    return requests;
  }
}
