export type Ability = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";
export type HeroClass = "fighter" | "rogue" | "wizard";
export type Skill = "athletics" | "stealth" | "investigation" | "perception" | "insight" | "persuasion" | "arcana";
export type Hero = {
  id: string; name: string; classId: HeroClass; species: string; background: string;
  abilities: Record<Ability, number>; skills: Skill[]; hp: number; maxHp: number; ac: number;
  potions: number; hitDice: number; secondWind: number; spellSlots: number;
};
export type Player = { userId: string; hero: Hero };
export type Action = {
  id: string; kind: "automatic" | "check" | "combat"; title: string; description: string; skill?: Skill; dc?: number;
  consequence?: string; clue?: string; next?: number; ending?: string;
  advantageFlag?: string; flag?: string; requiresClue?: string; failureDamage?: number; timeCost?: number;
};
export type Scene = { id: string; title: string; description: string; npc: string; actions: Action[]; enemy?: Enemy; safeRest?: boolean };
export type Enemy = { name: string; hp: number; maxHp: number; ac: number; attackBonus: number; damageDie: number; damageBonus: number; dex: number };
export type Campaign = {
  $schema: string; schemaVersion: 1; rulesVersion: "srd-5.1-teaching-1"; revision: number; order: number; flags: string[];
  id: string; title: string; subtitle: string; description: string; minutes: string;
  theme: string; difficulty: string; hook: string; clues: Record<string, { title: string; text: string }>;
  scenes: Scene[]; endings: Record<string, { title: string; text: string }>;
};
export type Check = {
  id: string; actorId: string; actionId: string; title: string; skill: Skill;
  dc: number; modifier: number; advantage: boolean; consequence: string;
};
export type Roll = {
  label: string; rolls: number[]; kept: number; modifier: number; total: number;
  target: number; success: boolean; kind: "check" | "attack" | "initiative" | "damage" | "healing";
  explanation: string; damage?: number;
};
export type Message = { id: string; role: "dm" | "player" | "system"; text: string; actor?: string; roll?: Roll; ai?: boolean };
export type Combat = { enemy: Enemy; order: string[]; turn: number; round: number; guard: string[]; next: number; clue?: string };
export type Game = {
  id: string; owner: string; roomCode: string; mode: "solo" | "party";
  campaignId: string; campaignRevision: number; campaignSnapshot: Campaign; players: Player[]; status: "waiting" | "active" | "complete";
  scene: number; clues: string[]; flags: string[]; danger: number; turns: number;
  pending: Check | null; combat: Combat | null; messages: Message[]; ending: string | null;
  requestIds: string[]; lastRestScene?: number;
};
export type Intent = { kind: "action" | "question" | "impossible"; actionId?: string; response?: string };
export type Resolution = { state: Game; fact: string; rolls: Roll[] };
export type PublicGame = Omit<Game, "campaignSnapshot" | "requestIds">;
export type View = { game: PublicGame; scene: Pick<Scene, "id" | "title" | "description"> & {safeRest: boolean}; actions: Action[]; version: number; title: string; sceneCount: number; ending: {title: string; text: string} | null; clues: {title: string; text: string}[] };
