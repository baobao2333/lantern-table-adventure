import type { Command, Die } from "../../lib/game/engine.ts";
import type { Campaign, Game, HeroBuildInput, Intent, PartyRestChoice, PartyRestChoices, Roll, View } from "../../lib/game/types.ts";
import type { ProposedIdea } from "../../lib/game/world-engine.ts";

export type RoomTimers = { operationMs: number; confirmMs: number; voteMs: number; aiMs: number; narrationMs: number; offlineMs: number };
export type RoomClock = { monotonic(): number; wall(): number };
export type RoomSeat = { id: string; userId: string; heroId: string; host: boolean; ready: boolean; revoked: boolean; tokenHash: string; recoveryHash: string; lastSeen: number; online?: boolean };
export type RoomOperation = {
  id: string; phaseId: string; seatId: string; kind: "exploration" | "combat";
  phase: "action" | "confirm" | "vote" | "rest" | "ai";
  remainingMs: number; phaseRemainingMs: number; aiUsedMs: number;
  aiCommandId?: string; proposedCommand?: Command; warning15?: boolean; warning5?: boolean;
};
export type RoomVote = {
  id: string; operationId: string; initiator: string; eligible: string[];
  ballots: Record<string, boolean>; command: Command; stateVersion: number;
  restChoices: PartyRestChoices; choiceSeats: string[]; approved: boolean;
};
export type RoomState = {
  id: string; game: Game; status: "lobby" | "active" | "paused" | "complete";
  pauseReason?: string; stateVersion: number; eventSeq: number; serverEpoch: number;
  seats: RoomSeat[]; inviteHash: string; queue: string[]; operation: RoomOperation | null;
  vote: RoomVote | null; timeoutHeroIds: string[]; timers: RoomTimers; contentDigest: string;
};
export type RoomRequest = {
  commandId: string; serverEpoch: number; stateVersion?: number; operationId?: string; phaseId?: string;
  type: "start" | "pause" | "resume" | "ready" | "build" | "claim" | "pass" | "command" | "talk" | "chat" | "vote" | "rest-choice" | "rules" | "kick" | "rotate-invite" | "heartbeat";
  command?: Command; text?: string; ready?: boolean; build?: HeroBuildInput; yes?: boolean;
  choice?: PartyRestChoice; seatId?: string; timers?: Partial<RoomTimers>; transportFailed?: boolean;
};
export type RoomReceipt = {
  commandId: string; status: "processing" | "success" | "rejected" | "interrupted";
  stateVersion: number; eventSeq: number; serverEpoch: number; fact?: string; error?: string;
  rolls: Roll[]; resources?: { userId: string; before: Record<string, number>; after: Record<string, number> }[];
};
export type RoomEvent = { seq: number; at: number; type: string; actorSeatId?: string; commandId?: string; fact?: string; rolls?: Roll[]; narrationFor?: string };
export type PublicSeat = Pick<RoomSeat, "id" | "userId" | "heroId" | "host" | "ready"> & { online: boolean };
export type RoomSnapshot = {
  id: string; status: RoomState["status"]; pauseReason?: string; serverEpoch: number; stateVersion: number;
  eventSeq: number; serverTime: number; contentDigest: string; seats: PublicSeat[]; currentSeatId: string | null;
  operation: (RoomOperation & { deadline: number }) | null; vote: RoomVote | null;
  queue: string[]; timers: RoomTimers; view: View; events: RoomEvent[]; aiReady: boolean;
  mySeatId?: string; inviteCode?: string;
};
export type RoomAiIntent = Intent | { kind: "proposal" | "question" | "impossible"; response?: string; idea?: ProposedIdea | null };
export type RoomServiceOptions = {
  campaign?: (id: string) => Campaign;
  aiReady?: () => boolean;
  interpret?: (game: Game, actorUserId: string, text: string, signal: AbortSignal) => Promise<RoomAiIntent>;
  narrate?: (game: Game, fact: string, actorUserId: string, signal: AbortSignal) => Promise<string>;
  onUpdate?: (roomId: string) => void; clock?: RoomClock; die?: Die;
  protectSecret?: (value: string, decrypt?: boolean) => string;
};
export type JoinExchange = { joinAttemptId: string; recoveryProof: string };
