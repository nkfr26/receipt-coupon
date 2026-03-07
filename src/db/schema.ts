import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const coupons = sqliteTable("coupons", {
  id: text("id").primaryKey(),
  exp: integer("exp", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
});
