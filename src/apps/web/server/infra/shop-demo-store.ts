import type { ShopDb } from "../db/index.js";
import { customers, orders, products, refunds, replies, requests, shipments } from "../db/schema.js";
import { createShopDemoData } from "../db/shop-demo-data.js";
import { clearShopDependents, type ShopResetOptions } from "./shop-reset-dependents.js";

type Transaction = Parameters<Parameters<ShopDb["transaction"]>[0]>[0];

async function clearShop(tx: Transaction): Promise<void> {
  // Operational dependents have already been removed in this same transaction.
  await tx.delete(replies);
  await tx.delete(refunds);
  await tx.delete(requests);
  await tx.delete(shipments);
  await tx.delete(orders);
  await tx.delete(products);
  await tx.delete(customers);
}

export async function resetShop(db: ShopDb, options: ShopResetOptions = {}): Promise<void> {
  await db.transaction(async (tx) => {
    await clearShopDependents(tx, options);
    await clearShop(tx);
  });
}

/** Replace shop+associated operational data atomically; recipes survive unless all.
 * Framework data and migration bookkeeping always survive. */
export async function seedShop(db: ShopDb, options: ShopResetOptions = {}): Promise<Record<string, number>> {
  const data = createShopDemoData();
  await db.transaction(async (tx) => {
    await clearShopDependents(tx, options);
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
