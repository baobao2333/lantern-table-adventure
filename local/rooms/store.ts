import type { DatabaseSync } from "node:sqlite";
import type { RoomEvent, RoomReceipt, RoomState } from "./types.ts";

export class RoomStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS room_states (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_receipts (room_id TEXT NOT NULL, seat_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,seat_id,command_id));
      CREATE TABLE IF NOT EXISTS room_events (room_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,seq));
      CREATE TABLE IF NOT EXISTS room_joins (room_id TEXT NOT NULL, attempt_id TEXT NOT NULL, invite_hash TEXT NOT NULL, proof_hash TEXT NOT NULL, digest TEXT NOT NULL, seat_id TEXT NOT NULL, encrypted TEXT, expires_at INTEGER NOT NULL, PRIMARY KEY(room_id,attempt_id));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  all(): RoomState[] { return this.db.prepare("SELECT data FROM room_states").all().map(row => JSON.parse(row.data as string)); }
  get(id: string): RoomState {
    const row = this.db.prepare("SELECT data FROM room_states WHERE id=?").get(id);
    if (!row) throw new Error("房间不存在。");
    return JSON.parse(row.data as string);
  }
  put(room: RoomState) { this.db.prepare("INSERT INTO room_states(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(room.id, JSON.stringify(room)); }
  receipt(roomId: string, seatId: string, commandId: string): { digest: string; receipt: RoomReceipt } | null {
    const row = this.db.prepare("SELECT digest,data FROM room_receipts WHERE room_id=? AND seat_id=? AND command_id=?").get(roomId, seatId, commandId);
    return row ? { digest: row.digest as string, receipt: JSON.parse(row.data as string) } : null;
  }
  putReceipt(roomId: string, seatId: string, digest: string, receipt: RoomReceipt) {
    this.db.prepare("INSERT INTO room_receipts(room_id,seat_id,command_id,digest,data) VALUES(?,?,?,?,?) ON CONFLICT(room_id,seat_id,command_id) DO UPDATE SET data=excluded.data").run(roomId, seatId, receipt.commandId, digest, JSON.stringify(receipt));
  }
  interruptProcessing(room: RoomState, reason: string) {
    for (const row of this.db.prepare("SELECT seat_id,digest,data FROM room_receipts WHERE room_id=?").all(room.id)) {
      const receipt = JSON.parse(row.data as string) as RoomReceipt;
      if (receipt.status === "processing") this.putReceipt(room.id, row.seat_id as string, row.digest as string, { ...receipt, status: "interrupted", error: reason, serverEpoch: room.serverEpoch, eventSeq: room.eventSeq });
    }
  }
  event(room: RoomState, event: Omit<RoomEvent, "seq">): RoomEvent {
    const saved = { ...event, seq: ++room.eventSeq };
    this.db.prepare("INSERT INTO room_events(room_id,seq,at,data) VALUES(?,?,?,?)").run(room.id, saved.seq, saved.at, JSON.stringify(saved));
    this.db.prepare("DELETE FROM room_events WHERE room_id=? AND (seq<=? OR at<?)").run(room.id, room.eventSeq - 1000, event.at - 86_400_000);
    return saved;
  }
  events(roomId: string, after = 0): RoomEvent[] {
    return this.db.prepare("SELECT data FROM room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 1000").all(roomId, after).map(row => JSON.parse(row.data as string));
  }
}
