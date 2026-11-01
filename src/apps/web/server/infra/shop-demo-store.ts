import type { ShopDb } from "../db/index.js";
import { customers, orders, products, refunds, replies, requests, shipments } from "../db/schema.js";
import { createShopDemoData } from "../db/shop-demo-data.js";
import { lockShopWrites } from "./shop-repository.js";

type Transaction = Parameters<Parameters<ShopDb["transaction"]>[0]>[0];

async function clearShop(tx: Transaction): Promise<void> {
  // Child-first deletes preserve FK constraints and leave non-shop tables alone.
  await tx.delete(replies);
  await tx.delete(refunds);
  await tx.delete(requests);
  await tx.delete(shipments);
  await tx.delete(orders);
  await tx.delete(products);
  await tx.delete(customers);
}

export async function resetShop(db: ShopDb): Promise<void> {
  await db.transaction(async (tx) => {
    await lockShopWrites(tx);
    await clearShop(tx);
  });
}

/** Replace all shop data atomically; migrations, framework and engine data survive. */
export async function seedShop(db: ShopDb): Promise<Record<string, number>> {
  const data = createShopDemoData();
  await db.transaction(async (tx) => {
    await lockShopWrites(tx);
    await clearShop(tx);
    await tx.insert(customers).values(data.customers);
    await tx.insert(products).values(data.products);
    await tx.insert(orders).values(data.orders);
    await tx.insert(shipments).values(data.shipments);
    await tx.insert(requests).values(data.requests);
    await tx.insert(refunds).values(data.refunds);
    await tx.insert(replies).values(data.replies);
  });
  return Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length]));
}
