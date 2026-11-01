import type {
  Customer, Order, Product, Refund, Reply, Request, RequestType, Shipment,
} from "@muscle-memory/shop-domain";
import type { HandoffContext, RecipeVersion, Run } from "@muscle-memory/recipe-engine";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";

export const customers = pgTable("customers", {
  id: varchar("id", { length: 31 }).$type<Customer["id"]>().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  shippingAddress: jsonb("shipping_address").$type<Customer["shippingAddress"]>().notNull(),
});

export const products = pgTable("products", {
  id: varchar("id", { length: 31 }).$type<Product["id"]>().primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  price: jsonb("price").$type<Product["price"]>().notNull(),
});

export const orders = pgTable("orders", {
  id: varchar("id", { length: 31 }).$type<Order["id"]>().primaryKey(),
  customerId: varchar("customer_id", { length: 31 }).$type<Order["customerId"]>().notNull().references(() => customers.id),
  // Purchased lines and prices are snapshots, independent of later catalog edits.
  items: jsonb("items").$type<Order["items"]>().notNull(),
  total: jsonb("total").$type<Order["total"]>().notNull(),
  paid: jsonb("paid").$type<Order["paid"]>().notNull(),
  status: text("status", { enum: ["unshipped", "shipped", "delivered", "cancelled"] }).notNull(),
  shippingAddress: jsonb("shipping_address").$type<Order["shippingAddress"]>().notNull(),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
  replacementForOrderId: varchar("replacement_for_order_id", { length: 31 }).$type<Order["id"]>().references((): AnyPgColumn => orders.id),
  returnLabel: jsonb("return_label").$type<Order["returnLabel"]>(),
}, (table) => [index("orders_customer_idx").on(table.customerId)]);

export const shipments = pgTable("shipments", {
  id: varchar("id", { length: 31 }).$type<Shipment["id"]>().primaryKey(),
  orderId: varchar("order_id", { length: 31 }).$type<Shipment["orderId"]>().notNull().unique().references(() => orders.id),
  status: text("status", { enum: ["pending", "in_transit", "delivered", "exception", "cancelled"] }).notNull(),
  carrier: text("carrier").notNull(),
  trackingNumber: text("tracking_number"),
  shippedAt: text("shipped_at"),
  deliveredAt: text("delivered_at"),
  estimatedDeliveryAt: text("estimated_delivery_at"),
});

export const requests = pgTable("requests", {
  id: varchar("id", { length: 31 }).$type<Request["id"]>().primaryKey(),
  customerId: varchar("customer_id", { length: 31 }).$type<Request["customerId"]>().notNull().references(() => customers.id),
  orderId: varchar("order_id", { length: 31 }).$type<NonNullable<Request["orderId"]>>().references(() => orders.id),
  subject: text("subject").notNull(),
  content: jsonb("content").$type<Request["content"]>().notNull(),
  category: text("category").$type<RequestType>().generatedAlwaysAs(sql`CASE WHEN content->>'source' = 'structured' THEN content->'fields'->>'type' ELSE content->>'type' END`),
  status: text("status", { enum: ["open", "pending", "resolved", "escalated"] }).notNull(),
  tags: text("tags").array().$type<Request["tags"]>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  escalation: jsonb("escalation").$type<Request["escalation"]>(),
}, (table) => [
  index("requests_status_created_idx").on(table.status, table.createdAt, table.id),
  index("requests_category_idx").on(table.category),
  index("requests_customer_idx").on(table.customerId),
  index("requests_order_idx").on(table.orderId),
  index("requests_tags_idx").using("gin", table.tags),
]);

export const refunds = pgTable("refunds", {
  id: varchar("id", { length: 31 }).$type<Refund["id"]>().primaryKey(),
  orderId: varchar("order_id", { length: 31 }).$type<Refund["orderId"]>().notNull().references(() => orders.id),
  amount: jsonb("amount").$type<Refund["amount"]>().notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("refunds_order_idx").on(table.orderId)]);

export const replies = pgTable("replies", {
  id: varchar("id", { length: 31 }).$type<Reply["id"]>().primaryKey(),
  requestId: varchar("request_id", { length: 31 }).$type<Reply["requestId"]>().notNull().references(() => requests.id),
  customerId: varchar("customer_id", { length: 31 }).$type<Reply["customerId"]>().notNull().references(() => customers.id),
  to: text("recipient").notNull(),
  template: text("template").notNull(),
  variables: jsonb("variables").$type<Reply["variables"]>().notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("replies_request_idx").on(table.requestId), index("replies_customer_idx").on(table.customerId)]);

// Minimal immutable versions; registry/activation is a later task.
export const recipeVersions = pgTable("recipe_versions", {
  id: varchar("id", { length: 31 }).primaryKey(),
  recipeId: varchar("recipe_id", { length: 31 }).notNull(),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<RecipeVersion>().notNull(),
}, (table) => [uniqueIndex("recipe_versions_number_idx").on(table.recipeId, table.version)]);

export const recipeRuns = pgTable("recipe_runs", {
  id: varchar("id", { length: 31 }).primaryKey(),
  recipeVersionId: varchar("recipe_version_id", { length: 31 }).notNull().references(() => recipeVersions.id),
  // A single row atomically commits logs, results, metrics and continuation.
  checkpoint: jsonb("checkpoint").$type<Run>().notNull(),
}, (table) => [index("recipe_runs_version_idx").on(table.recipeVersionId)]);

export const recipeHandoffs = pgTable("recipe_handoffs", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  runId: varchar("run_id", { length: 31 }).notNull().references(() => recipeRuns.id),
  requestId: varchar("request_id", { length: 31 }).$type<Request["id"]>().references(() => requests.id),
  context: jsonb("context").$type<HandoffContext>().notNull(),
  // Pending work for the later UI; both targets retain the original context.
  disposition: text("disposition", { enum: ["with_agent", "with_human"] }).notNull(),
}, (table) => [index("recipe_handoffs_request_idx").on(table.requestId)]);
