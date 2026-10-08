import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const heroes = sqliteTable("heroes", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("idx_heroes_owner").on(table.owner)]);

export const adventures = sqliteTable("adventures", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  roomCode: text("room_code").notNull().unique(),
  data: text("data").notNull(),
  version: integer("version").notNull().default(0),
  lockToken: text("lock_token"),
  lockUntil: integer("lock_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("idx_adventures_owner").on(table.owner)]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  adventureId: text("adventure_id").notNull(),
  userId: text("user_id").notNull(),
}, (table) => [index("idx_memberships_user").on(table.userId), index("idx_memberships_adventure").on(table.adventureId)]);

export const camps = sqliteTable("camps", {
  heroId: text("hero_id").primaryKey(),
  owner: text("owner").notNull(),
  data: text("data").notNull(),
});
