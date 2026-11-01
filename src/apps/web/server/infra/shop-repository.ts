import type {
  CustomerId, Order, OrderId, ProductId, Refund, Reply, Request, RequestFilter,
  RequestId, Result, ShopRecords, ShopRepository, RequestActivityRecords,
} from "@muscle-memory/shop-domain";
import { and, arrayContains, asc, eq, sql } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { customers, orders, products, refunds, replies, requests, shipments } from "../db/schema.js";

type ShopConnection = Pick<ShopDb, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * All shop DML, including shipment writes outside this adapter, takes a conflicting
 * ROW EXCLUSIVE lock. Taking this stronger lock before any reads serializes the
 * whole callback across connections at READ COMMITTED. Readers remain unblocked.
 * A deliberately coarse lock is sufficient for the demo; callbacks are never retried.
 */
export async function lockShopWrites(db: ShopConnection): Promise<void> {
  await db.execute(sql`LOCK TABLE customers, products, orders, shipments, requests, refunds, replies IN SHARE ROW EXCLUSIVE MODE`);
}

class ResultRollback<T> extends Error {
  constructor(readonly result: Result<T>) { super("Shop transaction returned an error result"); }
}

function requestSnapshot(row: typeof requests.$inferSelect): Request {
  const { category: _category, ...request } = row;
  return structuredClone(request);
}

class DrizzleShopRecords implements ShopRecords {
  constructor(protected readonly db: ShopConnection) {}

  async listRequests(filter: RequestFilter): Promise<readonly Request[]> {
    const rows = await this.db.select().from(requests).where(and(
      filter.status === undefined ? undefined : eq(requests.status, filter.status),
      filter.type === undefined ? undefined : eq(requests.category, filter.type),
      filter.customerId === undefined ? undefined : eq(requests.customerId, filter.customerId),
      filter.tag === undefined ? undefined : arrayContains(requests.tags, [filter.tag]),
    )).orderBy(asc(requests.createdAt), asc(requests.id));
    return rows.map(requestSnapshot);
  }

  async getRequest(id: RequestId): Promise<Request | null> {
    const [row] = await this.db.select().from(requests).where(eq(requests.id, id));
    return row ? requestSnapshot(row) : null;
  }

  async saveRequest(request: Request): Promise<void> {
    const rows = await this.db.update(requests).set(structuredClone(request)).where(eq(requests.id, request.id)).returning({ id: requests.id });
    if (!rows.length) throw new Error(`Cannot save missing request ${request.id}`);
  }

  async getCustomer(id: CustomerId) {
    const [row] = await this.db.select().from(customers).where(eq(customers.id, id));
    return row ? structuredClone(row) : null;
  }

  async getProduct(id: ProductId) {
    const [row] = await this.db.select().from(products).where(eq(products.id, id));
    return row ? structuredClone(row) : null;
  }

  async getOrder(id: OrderId): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id));
    return row ? structuredClone(row) : null;
  }

  async createOrder(order: Order): Promise<void> {
    await this.db.insert(orders).values(structuredClone(order));
  }

  async saveOrder(order: Order): Promise<void> {
    const rows = await this.db.update(orders).set(structuredClone(order)).where(eq(orders.id, order.id)).returning({ id: orders.id });
    if (!rows.length) throw new Error(`Cannot save missing order ${order.id}`);
  }

  async getShipmentForOrder(orderId: OrderId) {
    const [row] = await this.db.select().from(shipments).where(eq(shipments.orderId, orderId));
    return row ? structuredClone(row) : null;
  }

  async listRefundsForOrder(orderId: OrderId): Promise<readonly Refund[]> {
    return structuredClone(await this.db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.createdAt), asc(refunds.id)));
  }

  async createRefund(refund: Refund): Promise<void> {
    await this.db.insert(refunds).values(structuredClone(refund));
  }

  async createReply(reply: Reply): Promise<void> {
    await this.db.insert(replies).values(structuredClone(reply));
  }
}

export class DrizzleShopRepository extends DrizzleShopRecords implements ShopRepository {
  constructor(private readonly database: ShopDb) { super(database); }

  async getRequestActivityRecords(requestId: RequestId): Promise<RequestActivityRecords | null> {
    // One consistent read snapshot while an operator or agent may be writing.
    return this.database.transaction(async (tx) => {
      const records = new DrizzleShopRecords(tx);
      const request = await records.getRequest(requestId);
      if (!request) return null;
      const order = request.orderId ? await records.getOrder(request.orderId) : null;
      const requestReplies = await tx.select().from(replies).where(eq(replies.requestId, requestId)).orderBy(asc(replies.createdAt), asc(replies.id));
      return structuredClone({ request, order, shipment: order ? await records.getShipmentForOrder(order.id) : null,
        replies: requestReplies,
        refunds: order ? await records.listRefundsForOrder(order.id) : [],
        replacements: order ? await tx.select().from(orders).where(eq(orders.replacementForOrderId, order.id)).orderBy(asc(orders.createdAt), asc(orders.id)) : [],
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async transaction<T>(work: (records: ShopRecords) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await this.database.transaction(async (tx) => {
        await lockShopWrites(tx);
        const result = await work(new DrizzleShopRecords(tx));
        if (!result.ok) throw new ResultRollback(result);
        return result;
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (error instanceof ResultRollback) return error.result as Result<T>;
      throw error;
    }
  }
}
