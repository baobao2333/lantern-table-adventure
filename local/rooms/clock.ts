import type { RoomOperation, RoomTimers } from "./types.ts";

export const DEFAULT_ROOM_TIMERS: RoomTimers = { operationMs: 90_000, confirmMs: 30_000, voteMs: 45_000, aiMs: 45_000, narrationMs: 45_000, offlineMs: 30_000 };
export const ROOM_TIMER_BOUNDS = { operationMs: [30_000, 180_000], confirmMs: [10_000, 60_000], voteMs: [15_000, 90_000], aiMs: [15_000, 60_000] } as const;

/** The AI queue consumes the same cumulative allowance as active inference. */
export function elapseOperation(operation: RoomOperation, elapsedMs: number, timers: RoomTimers): RoomOperation {
  const next = { ...operation }, elapsed = Math.max(0, elapsedMs);
  if (next.phase === "ai") next.aiUsedMs = Math.min(timers.aiMs, next.aiUsedMs + elapsed);
  else {
    next.remainingMs = Math.max(0, next.remainingMs - elapsed);
    next.phaseRemainingMs = Math.max(0, Math.min(next.remainingMs, next.phaseRemainingMs - elapsed));
  }
  return next;
}

export function phaseWindow(operation: RoomOperation, phase: RoomOperation["phase"], timers: RoomTimers): number {
  if (phase === "ai") return Math.max(0, timers.aiMs - operation.aiUsedMs);
  return Math.min(operation.remainingMs, phase === "confirm" ? timers.confirmMs : phase === "vote" || phase === "rest" ? timers.voteMs : operation.remainingMs);
}

export function operationExpired(operation: RoomOperation, timers: RoomTimers): boolean {
  return operation.phase === "ai" ? operation.aiUsedMs >= timers.aiMs : operation.remainingMs <= 0 || operation.phaseRemainingMs <= 0;
}
