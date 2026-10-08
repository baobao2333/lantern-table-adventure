import type { WorldConfig, WorldState } from "./world-types";
export type Ability = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";
export type HeroClass = "fighter" | "rogue" | "wizard";
export type Skill =
  | "athletics"
  | "acrobatics"
  | "sleightOfHand"
  | "stealth"
  | "arcana"
  | "history"
  | "investigation"
  | "nature"
  | "religion"
  | "animalHandling"
  | "insight"
  | "medicine"
  | "perception"
  | "survival"
  | "deception"
  | "intimidation"
  | "performance"
  | "persuasion";

export type SpeciesId =
  | "human"
  | "hill-dwarf"
  | "high-elf"
  | "lightfoot-halfling";
export type BackgroundId =
  | "acolyte"
  | "watch-keeper"
  | "archivist"
  | "traveler"
  | "custom";
export type FightingStyle = "defense" | "dueling" | "archery";
export type WeaponId =
  | "dagger"
  | "quarterstaff"
  | "handaxe"
  | "light-crossbow"
  | "shortbow"
  | "longsword"
  | "rapier"
  | "shortsword"
  | "scimitar"
  | "greatsword"
  | "battleaxe"
  | "warhammer"
  | "longbow";
export type PackId = "dungeoneer" | "explorer" | "burglar" | "scholar";
export type LanguageId =
  | "common"
  | "dwarvish"
  | "elvish"
  | "giant"
  | "gnomish"
  | "goblin"
  | "halfling"
  | "orc";
export type ToolId =
  | "smith"
  | "brewer"
  | "mason"
  | "thieves"
  | "disguise"
  | "forgery"
  | "dice"
  | "cards"
  | "flute"
  | "lute";
export type BackgroundExtra = `language:${LanguageId}` | `tool:${ToolId}`;
export type CantripId =
  | "fire-bolt"
  | "light"
  | "mage-hand"
  | "minor-illusion"
  | "prestidigitation"
  | "mending";
export type FirstLevelSpellId =
  | "magic-missile"
  | "mage-armor"
  | "sleep"
  | "burning-hands"
  | "disguise-self"
  | "comprehend-languages"
  | "detect-magic";
export type CharacterProfile = {
  personality: [string, string];
  ideal: string;
  bond: string;
  flaw: string;
  goal: string;
  cooperation: string;
  backstory: string;
};
export type EquipmentInput =
  | {
      kind: "fighter";
      armorPackage: "chain-mail" | "leather-longbow";
      weaponPackage: "weapon-shield" | "two-weapons";
      martialWeapons: WeaponId[];
      extraWeapons: "light-crossbow" | "two-handaxes";
      pack: "dungeoneer" | "explorer";
    }
  | {
      kind: "rogue";
      primaryWeapon: "rapier" | "shortsword";
      secondaryWeapon: "shortbow" | "shortsword";
      pack: "burglar" | "dungeoneer" | "explorer";
    }
  | {
      kind: "wizard";
      primaryWeapon: "quarterstaff" | "dagger";
      focus: "component-pouch" | "arcane-focus";
      pack: "scholar" | "explorer";
    };
export type HeroBuildInput = {
  id: string;
  name: string;
  classId: HeroClass;
  speciesId: SpeciesId;
  abilityMethod: "standard-array" | "point-buy";
  baseScores: Record<Ability, number>;
  backgroundId: BackgroundId;
  backgroundSkills: Skill[];
  backgroundExtras: BackgroundExtra[];
  classSkills: Skill[];
  expertise?: Skill[];
  fightingStyle?: FightingStyle;
  speciesLanguage?: LanguageId;
  dwarfTool?: "smith" | "brewer" | "mason";
  racialCantrip?: CantripId;
  equipment: EquipmentInput;
  equippedWeaponId: WeaponId;
  weaponGrip: "one-handed" | "two-handed";
  shieldEquipped: boolean;
  attackMode?: "melee" | "ranged";
  cantrips?: CantripId[];
  spellbook?: FirstLevelSpellId[];
  preparedSpells?: FirstLevelSpellId[];
  profile: CharacterProfile;
};
export type WeaponProfile = {
  id: WeaponId;
  name: string;
  ability: Ability;
  attackBonus: number;
  damageBonus: number;
  damageDie: number;
  damageDice: number;
  damageType: "piercing" | "slashing" | "bludgeoning";
  kind: "melee" | "ranged";
  attackMode: "melee" | "ranged";
  proficient: boolean;
  properties: string[];
  range?: { normal: number; long: number };
  disadvantageReasons: string[];
};
export type HeroBuild = {
  rulesVersion: "srd-5.1-table-2";
  level: 1;
  abilityMethod: HeroBuildInput["abilityMethod"];
  baseScores: Record<Ability, number>;
  speciesId: SpeciesId;
  speciesLanguage?: LanguageId;
  dwarfTool?: "smith" | "brewer" | "mason";
  backgroundId: BackgroundId;
  backgroundSkills: Skill[];
  backgroundExtras: BackgroundExtra[];
  classSkills: Skill[];
  expertise: Skill[];
  fightingStyle?: FightingStyle;
  equipment: EquipmentInput;
  equippedWeaponId: WeaponId;
  weaponGrip: HeroBuildInput["weaponGrip"];
  shieldEquipped: boolean;
  inventory: { id: string; quantity: number }[];
  weapon: WeaponProfile;
  armorId: "none" | "leather" | "chain-mail";
  armorStealthDisadvantage: boolean;
  proficiencyBonus: 2;
  savingThrowProficiencies: Ability[];
  weaponProficiencies: WeaponId[];
  toolProficiencies: ToolId[];
  languages: LanguageId[];
  speed: number;
  size: "Small" | "Medium";
  darkvision: number;
  traits: string[];
  racialCantrip?: CantripId;
  cantrips: CantripId[];
  spellbook: FirstLevelSpellId[];
  preparedSpells: FirstLevelSpellId[];
  spellAttackBonus: number;
  spellSaveDc: number;
  spellSlotMaximum: number;
  arcaneRecovery: number;
  profile: CharacterProfile;
};
export type SpellEffect = {
  spellId: CantripId | FirstLevelSpellId;
  casterId: string;
  startedAt: number;
  expiresAt: number;
  concentration: boolean;
  description: string;
};
export type Hero = {
  id: string;
  name: string;
  classId: HeroClass;
  species: string;
  background: string;
  abilities: Record<Ability, number>;
  skills: Skill[];
  hp: number;
  maxHp: number;
  ac: number;
  potions: number;
  hitDice: number;
  secondWind: number;
  spellSlots: number;
  build?: HeroBuild;
  activeSpellEffects?: SpellEffect[];
  arcaneRecoveryUsedChapter?: number;
};
export type Player = { userId: string; hero: Hero };
export type Action = {
  id: string;
  kind: "automatic" | "check" | "combat";
  title: string;
  description: string;
  skill?: Skill;
  dc?: number;
  consequence?: string;
  clue?: string;
  next?: number;
  ending?: string;
  advantageFlag?: string;
  flag?: string;
  requiresClue?: string;
  failureDamage?: number;
  timeCost?: number;
};
export type Scene = {
  id: string;
  title: string;
  description: string;
  npc: string;
  actions: Action[];
  enemy?: Enemy;
  safeRest?: boolean;
};
export type Enemy = {
  name: string;
  hp: number;
  maxHp: number;
  ac: number;
  attackBonus: number;
  damageDie: number;
  damageBonus: number;
  dex: number;
  sleepImmune?: boolean;
};
export type Campaign = {
  $schema: string;
  schemaVersion: 1 | 2;
  rulesVersion: "srd-5.1-teaching-1" | "srd-5.1-table-2";
  world?: WorldConfig;
  revision: number;
  order: number;
  flags: string[];
  id: string;
  title: string;
  subtitle: string;
  description: string;
  minutes: string;
  theme: string;
  difficulty: string;
  hook: string;
  clues: Record<string, { title: string; text: string }>;
  scenes: Scene[];
  endings: Record<string, { title: string; text: string }>;
};
export type Check = {
  id: string;
  actorId: string;
  actionId: string;
  title: string;
  skill: Skill;
  dc: number;
  modifier: number;
  advantage: boolean;
  disadvantage?: boolean;
  consequence: string;
};
export type Roll = {
  label: string;
  rolls: number[];
  kept: number;
  modifier: number;
  total: number;
  target: number;
  success: boolean;
  kind: "check" | "attack" | "initiative" | "damage" | "healing";
  explanation: string;
  damage?: number;
  rerolls?: { dieIndex: number; original: number; replacement: number }[];
};
export type Message = {
  id: string;
  role: "dm" | "player" | "system";
  text: string;
  actor?: string;
  roll?: Roll;
  ai?: boolean;
};
export type Combat = {
  enemy: Enemy;
  order: string[];
  turn: number;
  round: number;
  guard: string[];
  next: number;
  clue?: string;
};
export type Game = {
  id: string;
  owner: string;
  roomCode: string;
  mode: "solo" | "party";
  campaignId: string;
  campaignRevision: number;
  campaignSnapshot: Campaign;
  players: Player[];
  status: "waiting" | "active" | "complete";
  scene: number;
  clues: string[];
  flags: string[];
  danger: number;
  turns: number;
  pending: Check | null;
  combat: Combat | null;
  messages: Message[];
  ending: string | null;
  requestIds: string[];
  lastRestScene?: number;
  lastRestChapter?: number;
  elapsedMinutes?: number;
  world?: WorldState;
};
export type Intent = {
  kind: "action" | "question" | "impossible";
  actionId?: string;
  response?: string;
};
export type Resolution = { state: Game; fact: string; rolls: Roll[] };
export type PublicGame = Omit<Game, "campaignSnapshot" | "requestIds">;
export type View = {
  game: PublicGame;
  scene: Pick<Scene, "id" | "title" | "description"> & { safeRest: boolean };
  actions: Action[];
  version: number;
  world?: {
    location: string;
    session: number;
    npcs: {
      id: string;
      name: string;
      role: string;
      want: string;
      trust: number;
    }[];
    objectives: {
      id: string;
      title: string;
      description: string;
      done: boolean;
    }[];
    clocks: {
      id: string;
      title: string;
      current: number;
      max: number;
      stopped: boolean;
    }[];
    locations: {
      id: string;
      title: string;
      current: boolean;
      adjacent: boolean;
    }[];
    hooks: { id: string; question: string; truthStatus: string }[];
  };
  title: string;
  sceneCount: number;
  ending: { title: string; text: string } | null;
  clues: { title: string; text: string }[];
};
