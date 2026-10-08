import { env } from "cloudflare:workers";
import type { Game, Hero, Message } from "../game/types";

type GameRow = { id: string; data: string; version: number; room_code: string };
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function database() {
  if (!env.DB) throw new ApiError("存档服务尚未就绪，请稍后再试。", 503);
  return env.DB;
}
export async function listHeroes(owner: string): Promise<Hero[]> {
  const rows = await database().prepare("SELECT data FROM heroes WHERE owner = ? ORDER BY created_at DESC LIMIT 30").bind(owner).all<{data: string}>();
  return rows.results.map(row => JSON.parse(row.data));
}
export async function ownedHero(id: string, owner: string): Promise<Hero> {
  const row = await database().prepare("SELECT data FROM heroes WHERE id = ? AND owner = ?").bind(id, owner).first<{data: string}>();
  if (!row) throw new ApiError("没有找到你的角色。", 404);
  return JSON.parse(row.data);
}
export async function saveHero(hero: Hero, owner: string) {
  if ((await listHeroes(owner)).length >= 30) throw new ApiError("角色册已满（最多 30 位角色）。");
  await database().prepare("INSERT INTO heroes (id,owner,data,created_at) VALUES (?,?,?,?)").bind(hero.id, owner, JSON.stringify(hero), Date.now()).run();
}
export async function listGames(owner: string) {
  const rows = await database().prepare("SELECT a.id,a.data,a.version,a.room_code FROM adventures a JOIN memberships m ON m.adventure_id = a.id WHERE m.user_id = ? ORDER BY a.updated_at DESC LIMIT 30").bind(owner).all<GameRow>();
  return rows.results.map(row => ({ game: JSON.parse(row.data) as Game, version: row.version }));
}
export async function loadGame(id: string, owner: string) {
  const row = await database().prepare("SELECT a.id,a.data,a.version,a.room_code FROM adventures a JOIN memberships m ON m.adventure_id = a.id WHERE a.id = ? AND m.user_id = ?").bind(id, owner).first<GameRow>();
  if (!row) throw new ApiError("没有找到你的冒险存档。", 404);
  return { game: JSON.parse(row.data) as Game, version: row.version };
}
export async function insertGame(game: Game) {
  await database().batch([
    database().prepare("INSERT INTO adventures (id,owner,room_code,data,version,lock_until,updated_at) VALUES (?,?,?,?,0,0,?)").bind(game.id, game.owner, game.roomCode, JSON.stringify(game), Date.now()),
    database().prepare("INSERT INTO memberships (id,adventure_id,user_id) VALUES (?,?,?)").bind(`${game.id}:${game.owner}`, game.id, game.owner),
  ]);
}
export async function roomByCode(code: string) {
  const row = await database().prepare("SELECT id FROM adventures WHERE room_code = ?").bind(code).first<{id: string}>();
  if (!row) throw new ApiError("没有找到这个房间，请检查邀请码。", 404);
  return row.id;
}
export async function acquire(id: string, requestId: string) {
  const token = crypto.randomUUID();
  const result = await database().prepare("UPDATE adventures SET lock_token = ?,lock_until = ? WHERE id = ? AND lock_until < ?").bind(token, Date.now() + 90_000, id, Date.now()).run();
  if (result.meta.changes !== 1) throw new ApiError("另一个行动正在结算，请稍后重试。", 409);
  const row = await database().prepare("SELECT id,data,version,room_code FROM adventures WHERE id = ?").bind(id).first<GameRow>();
  if (!row) throw new ApiError("房间不存在。", 404);
  const game = JSON.parse(row.data) as Game;
  return { game, version: row.version, token, duplicate: game.requestIds.includes(requestId) };
}
export async function commit(game: Game, token: string, version: number, requestId: string, joinUser?: string) {
  game.requestIds = [...game.requestIds.filter(id => id !== requestId), requestId].slice(-100);
  const statement = database().prepare("UPDATE adventures SET data = ?,version = version + 1,updated_at = ? WHERE id = ? AND lock_token = ? AND version = ? AND lock_until > ?").bind(JSON.stringify(game), Date.now(), game.id, token, version, Date.now());
  // A join needs the same state commit and membership insertion to succeed together.
  if (joinUser) {
    const results = await database().batch([statement, database().prepare("INSERT OR IGNORE INTO memberships (id,adventure_id,user_id) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM adventures WHERE id = ? AND lock_token = ? AND version = ?)").bind(`${game.id}:${joinUser}`, game.id, joinUser, game.id, token, version + 1)]);
    if (results[0].meta.changes !== 1) throw new ApiError("存档已更新，请刷新后再试。", 409);
  } else {
    const result = await statement.run();
    if (result.meta.changes !== 1) throw new ApiError("存档已更新，请刷新后再试。", 409);
  }
  return version + 1;
}
export async function unlock(id: string, token: string) {
  await database().prepare("UPDATE adventures SET lock_token = NULL,lock_until = 0 WHERE id = ? AND lock_token = ?").bind(id, token).run();
}
export async function campLog(heroId: string, owner: string): Promise<Message[]> {
  const row = await database().prepare("SELECT data FROM camps WHERE hero_id = ? AND owner = ?").bind(heroId, owner).first<{data: string}>();
  return row ? JSON.parse(row.data) : [];
}
export async function saveCampLog(heroId: string, owner: string, messages: Message[]) {
  await database().prepare("INSERT INTO camps (hero_id,owner,data) VALUES (?,?,?) ON CONFLICT(hero_id) DO UPDATE SET data = excluded.data WHERE owner = excluded.owner").bind(heroId, owner, JSON.stringify(messages.slice(-60))).run();
}
