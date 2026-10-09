import type { DatabaseSync } from "node:sqlite";
import { LocalError } from "./settings.ts";

export type ClientJournalKind = "solo" | "room";
export type SoloJournalPayload = Record<string, unknown> & {
  op: "game.command" | "game.talk";
  id: string;
  requestId: string;
};
export type RoomJournalPayload = Record<string, unknown> & {
  id: string;
  role: "host" | "guest";
  payload: Record<string, unknown> & { commandId: string };
};
export type ClientJournalPayload = SoloJournalPayload | RoomJournalPayload;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumBytes = 64 * 1024;
function namespace(value: unknown): asserts value is ClientJournalKind {
  if (value !== "solo" && value !== "room")
    throw new LocalError("待确认请求类型不正确。");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new LocalError("待确认请求标识不正确。");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function canonicalJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 50) throw new LocalError("待确认请求结构过深。");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value))
    throw new LocalError("待确认请求必须是完整的 JSON 数据。");
  if (!Array.isArray(value) && !object(value))
    throw new LocalError("待确认请求必须是完整的 JSON 数据。");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++)
        entries.push(canonicalJson(value[index], ancestors, depth + 1));
      return `[${entries.join(",")}]`;
    }
    if (Object.getOwnPropertySymbols(value).length)
      throw new LocalError("待确认请求必须是完整的 JSON 数据。");
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors, depth + 1)}`,
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
function validated(kind: ClientJournalKind, payload: unknown) {
  if (!object(payload)) throw new LocalError("待确认请求需要 JSON 对象。");
  identifier(payload.id);
  let requestId: string;
  if (kind === "solo") {
    if (payload.op !== "game.command" && payload.op !== "game.talk")
      throw new LocalError("单人待确认请求不支持此操作。");
    identifier(payload.requestId);
    requestId = payload.requestId;
  } else {
    if ((payload.role !== "host" && payload.role !== "guest") || !object(payload.payload))
      throw new LocalError("房间待确认请求格式不正确。");
    identifier(payload.payload.commandId);
    requestId = payload.payload.commandId;
  }
  const data = canonicalJson(payload);
  if (Buffer.byteLength(data, "utf8") > maximumBytes)
    throw new LocalError("待确认请求太长。", 413);
  return { requestId, data };
}
function storageError(error: unknown): never {
  if (error instanceof LocalError) throw error;
  throw new LocalError("无法保存或读取待确认请求。请检查本机存档后重试。", 503);
}

export class ClientJournal {
  constructor(private readonly database: DatabaseSync) {
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS client_request_journal (
        kind TEXT PRIMARY KEY CHECK (kind IN ('solo','room')),
        request_id TEXT NOT NULL,
        payload TEXT NOT NULL
      )`);
    } catch (error) { storageError(error); }
  }
  read(kind: "solo"): SoloJournalPayload | null;
  read(kind: "room"): RoomJournalPayload | null;
  read(kind: ClientJournalKind): ClientJournalPayload | null;
  read(kind: ClientJournalKind): ClientJournalPayload | null {
    namespace(kind);
    try {
      const row = this.database.prepare("SELECT request_id,payload FROM client_request_journal WHERE kind=?").get(kind);
      if (!row) return null;
      const payload = JSON.parse(String(row.payload));
      const checked = validated(kind, payload);
      if (checked.requestId !== row.request_id || checked.data !== row.payload)
        throw new Error("Invalid persisted journal.");
      return payload as ClientJournalPayload;
    } catch (error) { storageError(error); }
  }
  save(kind: ClientJournalKind, payload: unknown): void {
    namespace(kind);
    const { requestId, data } = validated(kind, payload);
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      began = true;
      const existing = this.database.prepare("SELECT request_id,payload FROM client_request_journal WHERE kind=?").get(kind);
      if (existing && (existing.request_id !== requestId || existing.payload !== data))
        throw new LocalError("上次行动尚未确认，请先恢复原请求。", 409);
      if (!existing)
        this.database.prepare("INSERT INTO client_request_journal(kind,request_id,payload) VALUES(?,?,?)").run(kind, requestId, data);
      this.database.exec("COMMIT");
      began = false;
    } catch (error) {
      if (began) {
        try { this.database.exec("ROLLBACK"); } catch {}
      }
      storageError(error);
    }
  }
  clear(kind: ClientJournalKind, requestId: string): boolean {
    namespace(kind);
    identifier(requestId);
    try {
      return this.database.prepare("DELETE FROM client_request_journal WHERE kind=? AND request_id=?").run(kind, requestId).changes === 1;
    } catch (error) { storageError(error); }
  }
}
