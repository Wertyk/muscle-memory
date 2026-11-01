import type { CreateRequestInput } from "@muscle-memory/shop-domain";
import type { RequestIntake } from "./request-intake.js";

/** Scripted inputs reference TASK-6's deterministic seed. No recipes are
 * installed or outcomes precomputed by demo intake. All effects are real. */
export const demoIntakeScript: readonly CreateRequestInput[] = [
  { customerId: "cus_0006", subject: "Chipped rim on the sand bowl", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1006", productId: "prd_0010", quantity: 1, description: "The sand bowl has a chip along the rim. The other pieces arrived safely. Would a partial refund be possible? Thanks, Luca.",
  } } },
  { customerId: "cus_0016", subject: "Mug handle came off in the box", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1016", productId: "prd_0002", quantity: 1, description: "I opened the parcel this morning and found one Ocean mug with its handle broken off. Could you help with a refund for that piece? Best, Nina.",
  } } },
  { customerId: "cus_0002", subject: "A quick check on order ord_1042", content: { source: "free_text", text: "Hi Kiln & Co., could you check the shipment status of my order ord_1042? I'm hoping it will arrive before friends visit this weekend. Many thanks, Elias." } },
  { customerId: "cus_0001", subject: "A crack across the serving platter", content: { source: "structured", fields: {
    type: "damaged_item", orderId: "ord_1001", productId: "prd_0023", quantity: 1, description: "The large Ember serving platter arrived with a crack across the middle, although the wrapping looked intact. Please let me know how to arrange a refund. Regards, Maya.",
  } } },
  { customerId: "cus_0003", subject: "Mugs for Juniper & Clay", content: { source: "structured", fields: {
    type: "wholesale_inquiry", company: "Juniper & Clay Cafe", message: "We're opening a neighbourhood cafe and would love a quote for 60 mugs. Could you share the glaze options and lead time for an order that size? Best wishes, Priya.",
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
