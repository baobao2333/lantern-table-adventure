import type { Skill, Enemy } from "./types";
export type WorldOutcome = {
  text: string;
  clues: string[];
  objectives: string[];
  trustNpc?: string;
  ending?: string;
};
export type Opportunity = {
  id: string;
  location: string;
  title: string;
  prompt: string;
  skills: Skill[];
  dc: number;
  requires: string[];
  success: WorldOutcome;
  failure: { text: string; clock: number };
  encounter?: Enemy;
};
export type WorldConfig = {
  $schema: string;
  format: "situation-v1";
  schemaVersion: 2;
  rulesVersion: "srd-5.1-table-2";
  id: string;
  revision: number;
  order: number;
  title: string;
  subtitle: string;
  description: string;
  minutes: string;
  theme: string;
  difficulty: string;
  hook: string;
  locations: {
    id: string;
    title: string;
    description: string;
    npcIds: string[];
    exits: string[];
    safeRest: boolean;
  }[];
  npcs: {
    id: string;
    name: string;
    role: string;
    want: string;
    secret: string;
    location: string;
  }[];
  clues: Record<string, { title: string; text: string }>;
  objectives: Record<string, { title: string; description: string }>;
  opportunities: Opportunity[];
  clocks: {
    id: string;
    title: string;
    max: number;
    stoppedBy?: string[];
    thresholds: {
      at: number;
      text: string;
      clue?: string;
      objective?: string;
    }[];
  }[];
  endings: Record<
    string,
    { title: string; text: string; requires?: string[]; clues?: string[] }
  >;
  backstoryHooks: {
    id: string;
    location: string;
    question: string;
    tags: string[];
    truthStatus: "unresolved";
  }[];
};
export type WorldProposal = {
  id: string;
  actorId: string;
  location: string;
  title: string;
  approach: string;
  kind: "check" | "automatic";
  skill: Skill;
  dc: number;
  modifier: number;
  success: string;
  failure: string;
  timeCost: number;
  goalId?: string;
  travelTo?: string;
  npcId?: string;
  spellId?: string;
  attemptKey: string;
};
export type WorldState = {
  objectives: string[];
  clocks: Record<string, number>;
  trust: Record<string, number>;
  journal: {
    id: string;
    turn: number;
    location: string;
    text: string;
    kind: "event" | "decision" | "claim";
  }[];
  attempts: string[];
  proposal: WorldProposal | null;
  session: number;
  restAt: number;
  preparations: string[];
  battleGoal?: string;
};
