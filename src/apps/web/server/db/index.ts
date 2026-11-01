import { createGetDb } from "@agent-native/core/db";
import { registerIdentityColumns } from "@agent-native/core/org";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

registerIdentityColumns([
  { table: "customers", column: "email", emailChange: "retain", offboard: "retain", reason: "Synthetic shop customer contact, independent of workspace membership." },
]);

export type ShopDb = PgDatabase<PgQueryResultHKT, typeof schema>;
// Core and the app resolve the same Drizzle version through different pnpm peer
// contexts. Normalize its nominal SQL types once at this framework boundary.
export const getDb = createGetDb(schema) as unknown as () => ShopDb;
