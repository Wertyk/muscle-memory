import { runMigrations, type MigrationEntry } from "@agent-native/core/db";

// Append named entries here; never change an entry after it has shipped.
export const shopMigrations: MigrationEntry[] = [{
  version: 1,
  name: "task6-shop-tables",
  sql: `
    CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^cus_[a-z0-9]+$'),
      name TEXT NOT NULL, email TEXT NOT NULL, shipping_address JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^prd_[a-z0-9]+$'),
      sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^ord_[a-z0-9]+$'),
      customer_id VARCHAR(31) NOT NULL REFERENCES customers(id),
      items JSONB NOT NULL, total JSONB NOT NULL, paid JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unshipped','shipped','delivered','cancelled')),
      shipping_address JSONB NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT,
      replacement_for_order_id VARCHAR(31) REFERENCES orders(id), return_label JSONB
    );
    CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);
    CREATE TABLE IF NOT EXISTS shipments (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^shp_[a-z0-9]+$'),
      order_id VARCHAR(31) NOT NULL UNIQUE REFERENCES orders(id),
      status TEXT NOT NULL CHECK (status IN ('pending','in_transit','delivered','exception','cancelled')),
      carrier TEXT NOT NULL, tracking_number TEXT, shipped_at TEXT, delivered_at TEXT, estimated_delivery_at TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^req_[a-z0-9]+$'),
      customer_id VARCHAR(31) NOT NULL REFERENCES customers(id),
      order_id VARCHAR(31) REFERENCES orders(id), subject TEXT NOT NULL, content JSONB NOT NULL,
      category TEXT GENERATED ALWAYS AS (CASE WHEN content->>'source' = 'structured'
        THEN content->'fields'->>'type' ELSE content->>'type' END) STORED,
      status TEXT NOT NULL CHECK (status IN ('open','pending','resolved','escalated')),
      tags TEXT[] NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, escalation JSONB,
      CHECK (category IS NULL OR category IN ('damaged_item','where_is_my_order','return','address_change','wholesale_inquiry')),
      CHECK (content->>'source' IN ('structured','free_text')),
      CHECK (content->>'source' <> 'structured' OR NOT jsonb_exists(content->'fields', 'orderId')
        OR (order_id IS NOT NULL AND content->'fields'->>'orderId' = order_id))
    );
    CREATE INDEX IF NOT EXISTS requests_status_created_idx ON requests(status, created_at, id);
    CREATE INDEX IF NOT EXISTS requests_category_idx ON requests(category);
    CREATE INDEX IF NOT EXISTS requests_customer_idx ON requests(customer_id);
    CREATE INDEX IF NOT EXISTS requests_order_idx ON requests(order_id);
    CREATE INDEX IF NOT EXISTS requests_tags_idx ON requests USING gin(tags);
    CREATE TABLE IF NOT EXISTS refunds (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^ref_[a-z0-9]+$'),
      order_id VARCHAR(31) NOT NULL REFERENCES orders(id), amount JSONB NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds(order_id);
    CREATE TABLE IF NOT EXISTS replies (
      id VARCHAR(31) PRIMARY KEY CHECK (id ~ '^rpl_[a-z0-9]+$'),
      request_id VARCHAR(31) NOT NULL REFERENCES requests(id),
      customer_id VARCHAR(31) NOT NULL REFERENCES customers(id), recipient TEXT NOT NULL,
      template TEXT NOT NULL, variables JSONB NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS replies_request_idx ON replies(request_id);
    CREATE INDEX IF NOT EXISTS replies_customer_idx ON replies(customer_id);
  `,
}];

export const migrateShop = runMigrations(shopMigrations, { table: "_muscle_memory_shop_migrations" });
