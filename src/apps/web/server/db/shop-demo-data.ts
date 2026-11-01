import {
  ID_PREFIXES, REQUEST_TYPES, parseShopId,
  type Address, type Customer, type IdKind, type Money, type Order, type Product,
  type Refund, type Reply, type Request, type RequestType, type Shipment,
  type ShopId, type StructuredRequestFields,
} from "@muscle-memory/shop-domain";

export const DEMO_SEED = 20261102;
export const DEMO_NOW = "2026-11-02T12:00:00.000Z";
/** Stable content and offsets; the seed's clock is configurable for rehearsals. */
export function shopDemoAnchor(anchor?: string): string {
  // guard:allow-env-credential — TASK-8 reviewer authorized this non-secret rehearsal time anchor; it is not a credential.
  const configured = anchor ?? process.env.SHOP_DEMO_ANCHOR;
  const time = Date.parse(configured ?? new Date().toISOString());
  if (!Number.isFinite(time)) throw new Error("SHOP_DEMO_ANCHOR must be a valid ISO timestamp.");
  return new Date(Math.floor(time / 60_000) * 60_000).toISOString();
}
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface ShopDemoData {
  customers: Customer[];
  products: Product[];
  orders: Order[];
  shipments: Shipment[];
  requests: Request[];
  refunds: Refund[];
  replies: Reply[];
}

function id<K extends IdKind>(kind: K, number: number): ShopId<K> {
  const result = parseShopId(kind, `${ID_PREFIXES[kind]}_${String(number).padStart(4, "0")}`);
  if (!result.ok) throw new Error("Invalid fixture identifier");
  return result.value;
}

function usd(amountMinor: number): Money { return { amountMinor, currency: "USD" }; }
function dollars(amountMinor: number): string { return `USD ${(amountMinor / 100).toFixed(2)}`; }
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
function shifted(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function changedAddress(customer: Customer): Address {
  const number = Number(customer.id.slice(4));
  return {
    ...customer.shippingAddress,
    line1: at(["48 Willowmere Lane", "730 Lantern Ridge Road", "16 Mossbank Court", "205 Briarstone Avenue"], number % 4),
    line2: `Apt ${2 + number % 12}`,
  };
}
function addressText(address: Address): string {
  return `${address.line1}, ${address.line2}, ${address.city}, ${address.region} ${address.postalCode}`;
}

const damageDescriptions = [
  "One piece arrived with a chip along the rim. Could you refund half of its price?",
  "There is a hairline crack in one piece from my delivery. A partial refund would help.",
  "The edge of one piece broke in the box, although the rest arrived safely.",
  "I found a deep scratch through the glaze on one piece when I unpacked it.",
];
const returnReasons = [
  "The glaze is warmer than I expected and does not suit my kitchen.",
  "I ordered the wrong size for the shelf and would like to send it back.",
  "This was a gift, but the recipient already has the same piece.",
  "The shape does not fit our place settings. The items are unused.",
];
const wholesaleInquiries = [
  { company: "Juniper Table Cafe", quantity: 24, item: "mugs", quoteMinor: 43200, message: "We are opening a neighborhood cafe. Could you quote 24 mugs and share the lead time?" },
  { company: "Alder & Grain", quantity: 48, item: "bowls", quoteMinor: 129600, message: "We need 48 bowls for our autumn menu. Do you offer trade pricing and glaze samples?" },
  { company: "Hearthside Market", quantity: 36, item: "vases", quoteMinor: 183600, message: "Our shop would like to stock 36 vases. Please send your wholesale minimums and delivery schedule." },
  { company: "Willow Room Bakery", quantity: 60, item: "plates", quoteMinor: 189000, message: "Could we commission 60 plates for the bakery? We would love pricing and care instructions." },
];

function fieldsFor(type: RequestType, order: Order, customer: Customer, variant: number): StructuredRequestFields {
  switch (type) {
    case "damaged_item": return { type, orderId: order.id, productId: at(order.items, 0).productId, quantity: 1, description: at(damageDescriptions, variant) };
    case "where_is_my_order": return { type, orderId: order.id };
    case "return": return { type, orderId: order.id, reason: at(returnReasons, variant) };
    case "address_change": return { type, orderId: order.id, address: changedAddress(customer) };
    case "wholesale_inquiry": {
      const inquiry = at(wholesaleInquiries, variant);
      return { type, company: inquiry.company, message: inquiry.message };
    }
  }
}

function messageFor(type: RequestType, order: Order, customer: Customer, variant: number): { subject: string; text: string } {
  const item = at(order.items, 0).name;
  switch (type) {
    case "damaged_item": return at([
      { subject: "A chip in my new ceramic", text: `Hi Kiln & Co., one ${item} in ${order.id} arrived with a chipped rim. Could you refund half of that piece's price?` },
      { subject: "Crack in a piece from my delivery", text: `I unpacked ${order.id} this morning and spotted a hairline crack in one ${item}. The other pieces are fine. Can you help with a partial refund?` },
      { subject: "One piece broke in transit", text: `Thanks for the lovely pottery. Unfortunately, the edge of one ${item} from ${order.id} broke inside the box. What can we do about it?` },
      { subject: "Glaze scratched on arrival", text: `Hello, the ${item} in ${order.id} has a deep scratch through its glaze. I'd appreciate a refund for the damaged piece.` },
    ], variant);
    case "where_is_my_order": return at([
      { subject: "Any news on my delivery?", text: `Hi, could you check the tracking for ${order.id}? I haven't seen a delivery update yet.` },
      { subject: "Checking on my pottery order", text: `I'm looking forward to ${order.id}. Could you let me know which carrier has it and when it should arrive?` },
      { subject: "Has my order left the studio?", text: `Would you mind looking up ${order.id}? I'd love a tracking number so I can arrange to be home.` },
      { subject: "Delivery estimate for my order", text: `Hello Kiln & Co., can you share the latest shipment status for ${order.id}? I'm hoping it arrives before the weekend.` },
    ], variant);
    case "return": return at([
      { subject: "I'd like to return my order", text: `Could I return ${order.id}? The glaze is warmer than I expected. Please let me know how to get a return label.` },
      { subject: "Help with a return label", text: `The pieces from ${order.id} are lovely, but I chose the wrong size for my shelf. They're unused. Can I send them back?` },
      { subject: "Returning an unopened gift", text: `I'd like to return ${order.id}; the recipient already has the same piece. Could you send the return instructions?` },
      { subject: "Return within the return window", text: `Hello, the shapes in ${order.id} don't fit our place settings. Everything is unused and still in its packaging. Could you arrange a return?` },
    ], variant);
    case "address_change": {
      const address = addressText(changedAddress(customer));
      return at([
        { subject: "Please update my shipping address", text: `Before ${order.id} ships, could you change the delivery address to ${address}? Thank you!` },
        { subject: "I used my old address at checkout", text: `I just noticed the wrong address on ${order.id}. If it hasn't left yet, please send it to ${address} instead.` },
        { subject: "Can you redirect my order?", text: `Hi, I need ${order.id} delivered to ${address}. Is there still time to update it before dispatch?` },
        { subject: "A quick address correction", text: `Could you amend the shipping details for ${order.id} to ${address}? I entered the previous address by mistake.` },
      ], variant);
    }
    case "wholesale_inquiry": {
      const inquiry = at(wholesaleInquiries, variant);
      return at([
        { subject: "Mugs for our neighborhood cafe", text: `Hello from ${inquiry.company}! ${inquiry.message}` },
        { subject: "Trade pricing for our restaurant", text: `I'm writing on behalf of ${inquiry.company}. ${inquiry.message}` },
        { subject: "Stocking your ceramics in our shop", text: `Your ceramics would be a great fit for ${inquiry.company}. ${inquiry.message}` },
        { subject: "A tableware commission for our bakery", text: `Hi Kiln & Co., we're ${inquiry.company}. ${inquiry.message}` },
      ], variant);
    }
  }
}

/** Authored fixtures are identical for a fixed anchor; only their time origin moves. */
export function createShopDemoData(anchor = shopDemoAnchor()): ShopDemoData {
  const now = shopDemoAnchor(anchor);
  let randomState = DEMO_SEED;
  const random = (limit: number) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % limit;
  };
  const names = [
    "Maya Ashcombe", "Elias Navarro", "Priya Bellam", "Theo Okafor", "Noura Velden",
    "Luca Marlowe", "Amara Sethi", "Jonah Wrenley", "Yuna Calder", "Rafael Mosswell",
    "Imani Hartwick", "Felix Avenell", "Leila Moradi", "Adrian Vale", "Sora Whitcomb",
    "Nina Elridge", "Mateo Linden", "Zara Benali", "Oliver Fenwick", "Anika Solano",
    "Hugo Arlen", "Talia Mercier", "Arjun Westlake", "Clara Sorrel", "Samir Hollis",
    "Ines Saelwyn", "Daniel Roshan", "Mei Alderwick", "Esme Laurent", "Isaac Thornell",
    "Aisha Bellweather", "Gabriel Ibarra", "Hana Wycliffe", "Noah Serrin", "Sofia Kade",
    "Dara Lindholm", "Omar Fennell", "Elena Mireaux", "Kiran Ashford", "Vera Salcedo",
  ];
  const locations = [
    { city: "Alder Glen", region: "OR", postalCode: "97418" },
    { city: "Juniper Vale", region: "CO", postalCode: "80524" },
    { city: "Cedar Hollow", region: "NC", postalCode: "27516" },
    { city: "Harbor Ridge", region: "WA", postalCode: "98335" },
    { city: "Maple Crossing", region: "VT", postalCode: "05452" },
  ];
  const streets = ["Willowmere Drive", "Lantern Ridge Avenue", "Mossbank Lane", "Briarstone Court", "Silverleaf Terrace", "Orchard Bend Road", "Aster Hollow Way", "Lindenbrook Street"];
  const customers: Customer[] = names.map((name, i) => ({
    id: id("customer", i + 1), name,
    email: `${name.toLowerCase().replace(/ /g, ".")}@${i % 2 === 0 ? "example.com" : "example.test"}`,
    shippingAddress: {
      name, line1: `${418 + i * 23} ${at(streets, i % streets.length)}`,
      ...(i % 3 === 0 ? { line2: `Apt ${2 + i % 14}` } : {}),
      ...at(locations, i % locations.length), countryCode: "US",
    },
  }));
  const shapes = ["Mug", "Bowl", "Vase", "Plate", "Large Serving Platter"];
  const glazes = ["Chalk", "Ocean", "Ember", "Moss", "Sand"];
  const products: Product[] = Array.from({ length: 25 }, (_, i) => ({
    id: id("product", i + 1), sku: `KILN-${String(i + 1).padStart(3, "0")}`,
    name: `${at(glazes, i % 5)} ${at(shapes, Math.floor(i / 5))}`,
    price: usd(i >= 20 ? at([21000, 24500, 28000, 32000, 38000], i - 20) : at([2400, 3600, 6800, 4200], Math.floor(i / 5)) + (i % 5) * 200),
  }));
  const historicalTypes: RequestType[] = REQUEST_TYPES.flatMap((type) => Array<RequestType>(type === "damaged_item" ? 10 : 5).fill(type));
  const allTypes = [...Array.from({ length: 30 }, (_, i) => at(REQUEST_TYPES, i % 5)), ...historicalTypes];
  const requestedAt = allTypes.map((_, i) => shifted(now, i < 30
    ? -(15 + i * 139 + random(30)) * 60_000
    : -(5 + (i - 30) % 18) * DAY - random(12) * HOUR - random(60) * 60_000));
  const handledAt = requestedAt.map((timestamp, i) => i < 30 ? timestamp : shifted(timestamp, (45 + random(360)) * 60_000));
  const orders: Order[] = allTypes.map((type, i) => {
    const customer = at(customers, i % 40);
    // Stable approval and full-refund cases: neither relies on a lucky PRNG draw.
    const firstIndex = i === 0 ? 22 : i === 38 ? 24 : random(type === "damaged_item" ? 20 : 25);
    const first = at(products, firstIndex);
    const available = products.filter((p) => p.id !== first.id);
    const selected = [first];
    const lineCount = i === 38 ? 1 : 1 + random(4);
    while (selected.length < lineCount) selected.push(at(available.splice(random(available.length), 1), 0));
    const items = selected.map((product) => ({ productId: product.id, name: product.name, quantity: i === 38 ? 1 : 1 + random(4), unitPrice: { ...product.price } }));
    const amount = items.reduce((total, item) => total + item.quantity * item.unitPrice.amountMinor, 0);
    const status = type === "address_change" ? "unshipped" : type === "where_is_my_order" ? "shipped" : "delivered";
    const requestTime = at(requestedAt, i);
    const deliveredAt = status === "delivered" ? shifted(requestTime, -(1 + random(5)) * DAY) : null;
    return {
      id: id("order", 1001 + i), customerId: customer.id, items, total: usd(amount), paid: usd(amount), status,
      shippingAddress: { ...customer.shippingAddress }, createdAt: shifted(deliveredAt ?? requestTime, -(2 + random(5)) * DAY),
      deliveredAt, replacementForOrderId: null, returnLabel: null,
    };
  });
  const shipments: Shipment[] = orders.map((order, i) => ({
    id: id("shipment", 1001 + i), orderId: order.id,
    status: order.status === "unshipped" ? "pending" : order.status === "delivered" ? "delivered" : "in_transit",
    carrier: at(["Northline Parcel", "Cedar Post", "Claywell Courier"], i % 3),
    trackingNumber: order.status === "unshipped" ? null : `NP${String(1001 + i)}${String(7310 + i * 17)}`,
    shippedAt: order.status === "unshipped" ? null : shifted(order.deliveredAt ?? at(requestedAt, i), -DAY),
    deliveredAt: order.deliveredAt,
    estimatedDeliveryAt: order.status === "unshipped" ? null : order.deliveredAt ?? shifted(at(requestedAt, i), 2 * DAY),
  }));
  const sourceCounts = new Map<string, number>();
  const variants: number[] = [];
  const requests: Request[] = allTypes.map((type, i) => {
    const order = at(orders, i);
    const customer = at(customers, i % 40);
    const source = (i < 30 ? Math.floor(i / 5) : i - 30) % 2 === 0 ? "structured" : "free_text";
    const key = `${type}:${source}`;
    const count = sourceCounts.get(key) ?? 0;
    sourceCounts.set(key, count + 1);
    const variant = count % 4;
    variants.push(variant);
    const message = messageFor(type, order, customer, variant);
    return {
      id: id("request", i + 1), customerId: customer.id,
      orderId: type === "wholesale_inquiry" ? null : order.id, subject: message.subject,
      content: source === "structured"
        ? { source, fields: fieldsFor(type, order, customer, variant) }
        : { source, text: message.text, type },
      status: i < 30 ? "open" : "resolved",
      tags: i < 30 ? (i === 0 ? ["priority"] : []) : ["handled", type],
      createdAt: at(requestedAt, i), updatedAt: at(handledAt, i), escalation: null,
    };
  });
  const refunds: Refund[] = [];
  const replies: Reply[] = [];
  requests.slice(30).forEach((request, i) => {
    const type = at(historicalTypes, i);
    const orderIndex = i + 30;
    const order = at(orders, orderIndex);
    const customer = at(customers, orderIndex % 40);
    const timestamp = request.updatedAt;
    let outcome: string;
    let template = "Hello {{name}}, {{outcome}} — Kiln & Co.";
    switch (type) {
      case "damaged_item": {
        const damaged = at(order.items, 0);
        if (i === 7) {
          // Deliberate backtest deviation: replacement, with no refund.
          const replacement: Order = {
            ...order, id: id("order", 1061), items: [{ ...damaged, quantity: 1 }],
            total: { ...damaged.unitPrice }, paid: usd(0), status: "unshipped",
            createdAt: timestamp, deliveredAt: null, replacementForOrderId: order.id, returnLabel: null,
          };
          orders.push(replacement);
          shipments.push({ id: id("shipment", 1061), orderId: replacement.id, status: "pending", carrier: "Northline Parcel", trackingNumber: null, shippedAt: null, deliveredAt: null, estimatedDeliveryAt: null });
          requests[orderIndex] = { ...request, tags: [...request.tags, "replacement"] };
          outcome = `I'm sorry your ${damaged.name} arrived damaged. We arranged a replacement at no charge under ${replacement.id}, linked to ${order.id}.`;
        } else {
          // The other deviations are a full high-value refund and a distinct reply.
          const fullRefund = i === 8;
          const amount = usd(fullRefund ? damaged.unitPrice.amountMinor : Math.floor(damaged.unitPrice.amountMinor / 2));
          refunds.push({ id: id("refund", refunds.length + 1), orderId: order.id, amount, reason: fullRefund ? "Damaged platter: full refund" : "Damaged item: 50% of one unit price", createdAt: timestamp });
          outcome = fullRefund
            ? `Your ${damaged.name} was damaged in transit. I've refunded the full ${dollars(amount.amountMinor)} paid for ${order.id}.`
            : `I'm sorry one ${damaged.name} arrived damaged. I've refunded ${dollars(amount.amountMinor)}, half of that piece's price, for ${order.id}.`;
          if (i === 9) {
            template = "Hi {{name}}, {{outcome}} Warmly, Mara at Kiln & Co.";
            outcome = `Thank you for the photo of your ${damaged.name}. Your ${dollars(amount.amountMinor)} partial refund for ${order.id} is arranged. We'll also review the packaging with our studio team.`;
          }
        }
        break;
      }
      case "where_is_my_order": outcome = `Your order ${order.id} is in transit with ${at(shipments, orderIndex).carrier}, tracking ${at(shipments, orderIndex).trackingNumber}. You can follow its progress with the carrier.`; break;
      case "return": {
        const label = { id: id("returnLabel", i + 1), orderId: order.id, createdAt: timestamp, fromAddress: { ...order.shippingAddress } };
        orders[orderIndex] = { ...order, returnLabel: label };
        outcome = `Your return is within our 30-day window. Return label ${label.id} is ready for ${order.id}; please pack the pieces securely in their original packaging.`;
        break;
      }
      case "address_change": {
        const address = changedAddress(customer);
        orders[orderIndex] = { ...order, shippingAddress: address };
        outcome = `We've updated ${order.id} to ${addressText(address)} before dispatch. Thank you for catching that in time.`;
        break;
      }
      case "wholesale_inquiry": {
        const inquiry = at(wholesaleInquiries, at(variants, orderIndex));
        outcome = `For ${inquiry.company}, we can offer ${inquiry.quantity} ${inquiry.item} for ${dollars(inquiry.quoteMinor)} with a four-week lead time. We'd be happy to send glaze samples before you decide.`;
        break;
      }
    }
    replies.push({
      id: id("reply", i + 1), requestId: request.id, customerId: customer.id, to: customer.email,
      template, variables: { name: customer.name, outcome },
      body: template.replace("{{name}}", customer.name).replace("{{outcome}}", outcome), createdAt: timestamp,
    });
  });
  return { customers, products, orders, shipments, requests, refunds, replies };
}
