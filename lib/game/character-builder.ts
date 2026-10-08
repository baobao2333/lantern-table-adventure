import type {
  Ability,
  BackgroundExtra,
  BackgroundId,
  CantripId,
  CharacterProfile,
  EquipmentInput,
  FirstLevelSpellId,
  FightingStyle,
  Hero,
  HeroBuildInput,
  HeroClass,
  LanguageId,
  PackId,
  Skill,
  SpeciesId,
  ToolId,
  WeaponId,
  WeaponProfile,
} from "./types.ts";

export const TABLE_RULES_VERSION = "srd-5.1-table-2" as const;
export const ABILITY_OPTIONS: Record<Ability, string> = {
  STR: "力量",
  DEX: "敏捷",
  CON: "体质",
  INT: "智力",
  WIS: "感知",
  CHA: "魅力",
};
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;
export const POINT_BUY_COST: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};
export const BUILDER_SKILLS: Record<Skill, { name: string; ability: Ability }> =
  {
    athletics: { name: "运动", ability: "STR" },
    acrobatics: { name: "体操", ability: "DEX" },
    sleightOfHand: { name: "巧手", ability: "DEX" },
    stealth: { name: "隐匿", ability: "DEX" },
    arcana: { name: "奥秘", ability: "INT" },
    history: { name: "历史", ability: "INT" },
    investigation: { name: "调查", ability: "INT" },
    nature: { name: "自然", ability: "INT" },
    religion: { name: "宗教", ability: "INT" },
    animalHandling: { name: "驯兽", ability: "WIS" },
    insight: { name: "洞悉", ability: "WIS" },
    medicine: { name: "医药", ability: "WIS" },
    perception: { name: "察觉", ability: "WIS" },
    survival: { name: "求生", ability: "WIS" },
    deception: { name: "欺瞒", ability: "CHA" },
    intimidation: { name: "威吓", ability: "CHA" },
    performance: { name: "表演", ability: "CHA" },
    persuasion: { name: "游说", ability: "CHA" },
  };
export const LANGUAGE_OPTIONS: Record<LanguageId, string> = {
  common: "通用语",
  dwarvish: "矮人语",
  elvish: "精灵语",
  giant: "巨人语",
  gnomish: "侏儒语",
  goblin: "地精语",
  halfling: "半身人语",
  orc: "兽人语",
};
export const TOOL_OPTIONS: Record<ToolId, string> = {
  smith: "锻造工具",
  brewer: "酿酒工具",
  mason: "石匠工具",
  thieves: "盗贼工具",
  disguise: "易容工具",
  forgery: "伪造工具",
  dice: "骰子套装",
  cards: "纸牌套装",
  flute: "长笛",
  lute: "鲁特琴",
};
export const FIGHTING_STYLE_OPTIONS: Record<
  FightingStyle,
  { name: string; effect: string }
> = {
  defense: { name: "防御", effect: "穿着护甲时 AC +1。" },
  dueling: {
    name: "决斗",
    effect: "单手持一把近战武器且未持其他武器时，该武器伤害 +2；可持盾。",
  },
  archery: {
    name: "箭术",
    effect: "使用远程武器的攻击检定 +2；不适用于投掷近战武器。",
  },
};
type SpeciesOption = {
  name: string;
  bonuses: Partial<Record<Ability, number>>;
  size: "Small" | "Medium";
  speed: number;
  darkvision: number;
  skills: Skill[];
  languages: LanguageId[];
  extraLanguage: boolean;
  traits: string[];
  description: string;
};
export const SPECIES_OPTIONS: Record<SpeciesId, SpeciesOption> = {
  human: {
    name: "人类",
    bonuses: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 },
    size: "Medium",
    speed: 30,
    darkvision: 0,
    skills: [],
    languages: ["common"],
    extraLanguage: true,
    traits: [],
    description: "六项属性各 +1，另学一门语言；本桌使用普通人类。",
  },
  "hill-dwarf": {
    name: "丘陵矮人",
    bonuses: { CON: 2, WIS: 1 },
    size: "Medium",
    speed: 25,
    darkvision: 60,
    skills: [],
    languages: ["common", "dwarvish"],
    extraLanguage: false,
    traits: [
      "dwarven-resilience",
      "stonecunning",
      "dwarven-toughness",
      "heavy-armor-speed",
    ],
    description:
      "体质 +2、感知 +1，每级生命上限 +1；毒素、石工等条件特性仅记录，本版尚未模拟。",
  },
  "high-elf": {
    name: "高等精灵",
    bonuses: { DEX: 2, INT: 1 },
    size: "Medium",
    speed: 30,
    darkvision: 60,
    skills: ["perception"],
    languages: ["common", "elvish"],
    extraLanguage: true,
    traits: ["fey-ancestry", "trance"],
    description:
      "敏捷 +2、智力 +1，察觉熟练，另学一门语言和一个以智力施放的法师戏法。",
  },
  "lightfoot-halfling": {
    name: "轻足半身人",
    bonuses: { DEX: 2, CHA: 1 },
    size: "Small",
    speed: 25,
    darkvision: 0,
    skills: [],
    languages: ["common", "halfling"],
    extraLanguage: false,
    traits: [
      "halfling-lucky",
      "brave",
      "halfling-nimbleness",
      "naturally-stealthy",
    ],
    description:
      "敏捷 +2、魅力 +1；d20 掷出 1 可以重掷一次；躲藏仍需场景允许并通过检定。",
  },
};
type ClassOption = {
  name: string;
  hitDie: number;
  skillCount: number;
  skills: Skill[];
  saves: Ability[];
  description: string;
};
export const CLASS_OPTIONS: Record<HeroClass, ClassOption> = {
  fighter: {
    name: "战士",
    hitDie: 10,
    skillCount: 2,
    saves: ["STR", "CON"],
    skills: [
      "acrobatics",
      "animalHandling",
      "athletics",
      "history",
      "insight",
      "intimidation",
      "perception",
      "survival",
    ],
    description:
      "选择两项职业技能和一种已支持的战斗风格；复苏之风可在短休后恢复。",
  },
  rogue: {
    name: "游荡者",
    hitDie: 8,
    skillCount: 4,
    saves: ["DEX", "INT"],
    skills: [
      "acrobatics",
      "athletics",
      "deception",
      "insight",
      "intimidation",
      "investigation",
      "perception",
      "performance",
      "persuasion",
      "sleightOfHand",
      "stealth",
    ],
    description:
      "选择四项职业技能，再为两项已熟练技能选择专精；偷袭必须满足条件。",
  },
  wizard: {
    name: "法师",
    hitDie: 6,
    skillCount: 2,
    saves: ["INT", "WIS"],
    skills: [
      "arcana",
      "history",
      "insight",
      "investigation",
      "medicine",
      "religion",
    ],
    description:
      "选择三个戏法、六个法术书法术与每日准备列表；一级拥有两个一环法术位。",
  },
};
export const BACKGROUND_OPTIONS: Record<
  BackgroundId,
  {
    name: string;
    skills: [Skill, Skill];
    description: string;
    feature: string;
    source: "srd" | "custom";
  }
> = {
  acolyte: {
    name: "侍僧",
    skills: ["insight", "religion"],
    source: "srd",
    feature: "shelter-of-the-faithful",
    description: "曾在信仰共同体中生活；符合条件的同信仰机构可提供帮助。",
  },
  "watch-keeper": {
    name: "乡镇守望者",
    skills: ["athletics", "perception"],
    source: "custom",
    feature: "local-watch-contact",
    description:
      "原创自定义背景：熟悉守夜、巡逻和乡镇居民；联系人可成为故事入口，不保证检定成功。",
  },
  archivist: {
    name: "漂泊抄写员",
    skills: ["arcana", "history"],
    source: "custom",
    feature: "archive-contact",
    description:
      "原创自定义背景：追查散落的记录与未完成的研究；旧识提供交流机会，不自动揭露秘密。",
  },
  traveler: {
    name: "行路人",
    skills: ["survival", "persuasion"],
    source: "custom",
    feature: "road-contact",
    description:
      "原创自定义背景：沿商路寻找归属与生计；旅伴和商队可以成为关系线索。",
  },
  custom: {
    name: "自定义经历",
    skills: ["insight", "persuasion"],
    source: "custom",
    feature: "personal-contact",
    description:
      "选择两项技能以及合计两项工具熟练或语言；经历不能额外授予战斗能力。",
  },
};
type WeaponOption = {
  name: string;
  category: "simple" | "martial";
  kind: "melee" | "ranged";
  damageDie: number;
  damageDice: number;
  damageType: WeaponProfile["damageType"];
  properties: string[];
  versatileDie?: number;
  range?: { normal: number; long: number };
};
export const WEAPON_OPTIONS: Record<WeaponId, WeaponOption> = {
  dagger: {
    name: "匕首",
    category: "simple",
    kind: "melee",
    damageDie: 4,
    damageDice: 1,
    damageType: "piercing",
    properties: ["finesse", "light", "thrown"],
    range: { normal: 20, long: 60 },
  },
  quarterstaff: {
    name: "长棍",
    category: "simple",
    kind: "melee",
    damageDie: 6,
    damageDice: 1,
    damageType: "bludgeoning",
    properties: ["versatile"],
    versatileDie: 8,
  },
  handaxe: {
    name: "手斧",
    category: "simple",
    kind: "melee",
    damageDie: 6,
    damageDice: 1,
    damageType: "slashing",
    properties: ["light", "thrown"],
    range: { normal: 20, long: 60 },
  },
  "light-crossbow": {
    name: "轻弩",
    category: "simple",
    kind: "ranged",
    damageDie: 8,
    damageDice: 1,
    damageType: "piercing",
    properties: ["ammunition", "loading", "two-handed"],
    range: { normal: 80, long: 320 },
  },
  shortbow: {
    name: "短弓",
    category: "simple",
    kind: "ranged",
    damageDie: 6,
    damageDice: 1,
    damageType: "piercing",
    properties: ["ammunition", "two-handed"],
    range: { normal: 80, long: 320 },
  },
  longsword: {
    name: "长剑",
    category: "martial",
    kind: "melee",
    damageDie: 8,
    damageDice: 1,
    damageType: "slashing",
    properties: ["versatile"],
    versatileDie: 10,
  },
  rapier: {
    name: "细剑",
    category: "martial",
    kind: "melee",
    damageDie: 8,
    damageDice: 1,
    damageType: "piercing",
    properties: ["finesse"],
  },
  shortsword: {
    name: "短剑",
    category: "martial",
    kind: "melee",
    damageDie: 6,
    damageDice: 1,
    damageType: "piercing",
    properties: ["finesse", "light"],
  },
  scimitar: {
    name: "弯刀",
    category: "martial",
    kind: "melee",
    damageDie: 6,
    damageDice: 1,
    damageType: "slashing",
    properties: ["finesse", "light"],
  },
  greatsword: {
    name: "巨剑",
    category: "martial",
    kind: "melee",
    damageDie: 6,
    damageDice: 2,
    damageType: "slashing",
    properties: ["heavy", "two-handed"],
  },
  battleaxe: {
    name: "战斧",
    category: "martial",
    kind: "melee",
    damageDie: 8,
    damageDice: 1,
    damageType: "slashing",
    properties: ["versatile"],
    versatileDie: 10,
  },
  warhammer: {
    name: "战锤",
    category: "martial",
    kind: "melee",
    damageDie: 8,
    damageDice: 1,
    damageType: "bludgeoning",
    properties: ["versatile"],
    versatileDie: 10,
  },
  longbow: {
    name: "长弓",
    category: "martial",
    kind: "ranged",
    damageDie: 8,
    damageDice: 1,
    damageType: "piercing",
    properties: ["heavy", "ammunition", "two-handed"],
    range: { normal: 150, long: 600 },
  },
};
export const PACK_OPTIONS = {
  dungeoneer: "地城探索包",
  explorer: "野外探索包",
  burglar: "窃贼包",
  scholar: "学者包",
} as const;
export const PACK_CONTENTS: Record<
  PackId,
  readonly { id: string; quantity: number }[]
> = {
  dungeoneer: [
    { id: "backpack", quantity: 1 },
    { id: "crowbar", quantity: 1 },
    { id: "hammer", quantity: 1 },
    { id: "piton", quantity: 10 },
    { id: "torch", quantity: 10 },
    { id: "tinderbox", quantity: 1 },
    { id: "rations-day", quantity: 10 },
    { id: "waterskin", quantity: 1 },
    { id: "hempen-rope-50ft", quantity: 1 },
  ],
  explorer: [
    { id: "backpack", quantity: 1 },
    { id: "bedroll", quantity: 1 },
    { id: "mess-kit", quantity: 1 },
    { id: "tinderbox", quantity: 1 },
    { id: "torch", quantity: 10 },
    { id: "rations-day", quantity: 10 },
    { id: "waterskin", quantity: 1 },
    { id: "hempen-rope-50ft", quantity: 1 },
  ],
  burglar: [
    { id: "backpack", quantity: 1 },
    { id: "ball-bearings", quantity: 1000 },
    { id: "string-10ft", quantity: 1 },
    { id: "bell", quantity: 1 },
    { id: "candle", quantity: 5 },
    { id: "crowbar", quantity: 1 },
    { id: "hammer", quantity: 1 },
    { id: "piton", quantity: 10 },
    { id: "hooded-lantern", quantity: 1 },
    { id: "oil-flask", quantity: 2 },
    { id: "rations-day", quantity: 5 },
    { id: "tinderbox", quantity: 1 },
    { id: "waterskin", quantity: 1 },
    { id: "hempen-rope-50ft", quantity: 1 },
  ],
  scholar: [
    { id: "backpack", quantity: 1 },
    { id: "lore-book", quantity: 1 },
    { id: "ink-bottle", quantity: 1 },
    { id: "ink-pen", quantity: 1 },
    { id: "parchment", quantity: 10 },
    { id: "sand-bag", quantity: 1 },
    { id: "small-knife", quantity: 1 },
  ],
};
export const INVENTORY_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(WEAPON_OPTIONS).map(([id, weapon]) => [id, weapon.name]),
  ),
  "chain-mail": "锁子甲",
  leather: "皮甲",
  shield: "盾牌",
  arrows: "箭",
  bolts: "弩矢",
  "thieves-tools": "盗贼工具",
  "component-pouch": "材料包",
  "arcane-focus": "奥术法器",
  spellbook: "法术书",
  "common-clothes": "普通服装",
  pouch: "腰包",
  gold: "金币",
  "holy-symbol": "圣徽",
  "prayer-book": "祈祷书",
  incense: "熏香",
  vestments: "祭服",
  backpack: "背包",
  crowbar: "撬棍",
  hammer: "锤子",
  piton: "岩钉",
  torch: "火把",
  tinderbox: "火绒盒",
  "rations-day": "干粮（天）",
  waterskin: "水袋",
  "hempen-rope-50ft": "50 尺麻绳",
  bedroll: "铺盖",
  "mess-kit": "炊具",
  "ball-bearings": "滚珠",
  "string-10ft": "10 尺细绳",
  bell: "铃铛",
  candle: "蜡烛",
  "hooded-lantern": "附盖提灯",
  "oil-flask": "油瓶",
  "lore-book": "知识典籍",
  "ink-bottle": "墨水瓶",
  "ink-pen": "墨水笔",
  parchment: "羊皮纸",
  "sand-bag": "小袋细沙",
  "small-knife": "小刀",
};
type SpellOption = {
  name: string;
  capability: "combat" | "exploration";
  description: string;
  ritual?: boolean;
};
export const CANTRIP_OPTIONS: Record<CantripId, SpellOption> = {
  "fire-bolt": {
    name: "火焰箭",
    capability: "combat",
    description: "远程法术攻击；一级命中造成 1d10 火焰伤害。",
  },
  light: {
    name: "光亮术",
    capability: "exploration",
    description: "触碰物件，持续 1 小时；20 尺明亮光照，另有 20 尺微光。",
  },
  "mage-hand": {
    name: "法师之手",
    capability: "exploration",
    description:
      "30 尺内操纵物品，最多 10 磅；不能攻击、激活魔法物品或自动开锁。",
  },
  "minor-illusion": {
    name: "次级幻影",
    capability: "exploration",
    description:
      "30 尺内制造声音或至多 5 尺立方的物件影像，持续 1 分钟；触碰或调查可能揭穿。",
  },
  prestidigitation: {
    name: "魔法伎俩",
    capability: "exploration",
    description:
      "10 尺内制造有限无害效果；不能造成伤害、控制人物或制造有价值物品。",
  },
  mending: {
    name: "修复术",
    capability: "exploration",
    description: "施放 1 分钟，修补不超过 1 尺的单处破损；不能恢复魔法。",
  },
};
export const FIRST_LEVEL_SPELL_OPTIONS: Record<FirstLevelSpellId, SpellOption> =
  {
    "magic-missile": {
      name: "魔法飞弹",
      capability: "combat",
      description: "三个自动命中的飞弹，每个造成 1d4+1 力场伤害；消耗法术位。",
    },
    "mage-armor": {
      name: "法师护甲",
      capability: "combat",
      description:
        "未穿护甲的目标 AC 变为 13+敏捷调整值，持续 8 小时；不与普通护甲叠加。",
    },
    sleep: {
      name: "睡眠术",
      capability: "combat",
      description:
        "以 5d8 的生命池，从区域内当前生命最少的生物开始影响；不能令精灵或不死生物入睡。",
    },
    "burning-hands": {
      name: "燃烧之手",
      capability: "combat",
      description: "15 尺锥形；3d6 火焰伤害，敏捷豁免成功减半。",
    },
    "disguise-self": {
      name: "易容术",
      capability: "exploration",
      description:
        "改变可见外观 1 小时；不改变身体、能力或实际物品；接触与调查可能揭穿。",
    },
    "comprehend-languages": {
      name: "通晓语言",
      capability: "exploration",
      ritual: true,
      description:
        "理解所听语言与触碰文字的字面意思，持续 1 小时；不能翻译暗号，也不授予说话能力。",
    },
    "detect-magic": {
      name: "侦测魔法",
      capability: "exploration",
      ritual: true,
      description:
        "感知 30 尺内魔法存在，专注最多 10 分钟；不自动鉴定物品、发现秘密或读取思想。",
    },
  };
export const PROFILE_FIELDS = {
  personality: "两项性格特点",
  ideal: "理想",
  bond: "羁绊",
  flaw: "缺点",
  goal: "冒险目标",
  cooperation: "合作理由",
  backstory: "过去的经历",
} as const;
export const BUILDER_LIMITS = {
  name: 24,
  profileField: 300,
  backstory: 600,
  pointBuy: 27,
  note: "本次支持一级角色、部分武器/战斗风格/法术；原创背景使用自定义背景规则。没有完整 D&D 规则，也不会从人物经历新增能力。",
} as const;

export class CharacterBuildError extends Error {
  code: string;
  field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = "CharacterBuildError";
    this.code = code;
    this.field = field;
  }
}
function fail(code: string, field: string, message: string): never {
  throw new CharacterBuildError(code, field, message);
}
function record(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid_object", field, "角色配置必须是对象。");
}
function option<T extends string>(
  value: unknown,
  options: Record<T, unknown>,
  field: string,
): asserts value is T {
  if (typeof value !== "string" || !Object.hasOwn(options, value))
    fail("invalid_option", field, "请选择受支持的选项。");
}
function choices<T extends string>(
  value: unknown,
  options: Record<T, unknown>,
  count: number,
  field: string,
): asserts value is T[] {
  if (!Array.isArray(value) || value.length !== count)
    fail("invalid_choice_count", field, `需要选择 ${count} 项。`);
  for (const entry of value) option(entry, options, field);
  if (new Set(value).size !== value.length)
    fail("duplicate_choice", field, "不能重复选择同一项。");
}
function text(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length > maximum ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    fail(
      "invalid_text",
      field,
      `请填写${allowEmpty ? "不超过" : "1 至"} ${maximum} 字的文字。`,
    );
  }
  return value.trim();
}
export function buildAbilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}
export function pointBuyCost(scores: Record<Ability, number>): number {
  record(scores, "baseScores");
  return (Object.keys(ABILITY_OPTIONS) as Ability[]).reduce(
    (total, ability) => {
      const score = scores[ability];
      if (
        !Object.hasOwn(scores, ability) ||
        !Number.isInteger(score) ||
        !Object.hasOwn(POINT_BUY_COST, score)
      )
        fail(
          "invalid_ability_score",
          `baseScores.${ability}`,
          "种族加值前，属性必须为 8 至 15 的整数。",
        );
      return total + POINT_BUY_COST[score];
    },
    0,
  );
}
function validateScores(input: HeroBuildInput): void {
  record(input.baseScores, "baseScores");
  const abilities = Object.keys(ABILITY_OPTIONS) as Ability[];
  if (Object.keys(input.baseScores).length !== abilities.length)
    fail(
      "invalid_ability_scores",
      "baseScores",
      "需要六项属性且不能加入其他字段。",
    );
  const cost = pointBuyCost(input.baseScores);
  if (input.abilityMethod === "standard-array") {
    const actual = abilities
      .map((ability) => input.baseScores[ability])
      .sort((a, b) => b - a);
    if (actual.some((score, index) => score !== STANDARD_ARRAY[index]))
      fail(
        "invalid_standard_array",
        "baseScores",
        "标准数组必须恰好分配 15、14、13、12、10、8。",
      );
  } else if (input.abilityMethod === "point-buy") {
    if (cost > BUILDER_LIMITS.pointBuy)
      fail("point_buy_budget", "baseScores", "购点总费用不能超过 27 点。");
  } else
    fail(
      "invalid_ability_method",
      "abilityMethod",
      "请选择标准数组或 27 点购点。",
    );
}
function parseProfile(value: CharacterProfile): CharacterProfile {
  record(value, "profile");
  if (!Array.isArray(value.personality) || value.personality.length !== 2)
    fail("invalid_choice_count", "profile.personality", "请填写两项性格特点。");
  return {
    personality: value.personality.map((entry, index) =>
      text(entry, `profile.personality.${index}`, BUILDER_LIMITS.profileField),
    ) as [string, string],
    ideal: text(value.ideal, "profile.ideal", BUILDER_LIMITS.profileField),
    bond: text(value.bond, "profile.bond", BUILDER_LIMITS.profileField),
    flaw: text(value.flaw, "profile.flaw", BUILDER_LIMITS.profileField),
    goal: text(value.goal, "profile.goal", BUILDER_LIMITS.profileField),
    cooperation: text(
      value.cooperation,
      "profile.cooperation",
      BUILDER_LIMITS.profileField,
    ),
    backstory: text(
      value.backstory,
      "profile.backstory",
      BUILDER_LIMITS.backstory,
      true,
    ),
  };
}
function resolveEquipment(input: HeroBuildInput) {
  const equipment = input.equipment;
  record(equipment, "equipment");
  if (equipment.kind !== input.classId)
    fail(
      "invalid_equipment_class",
      "equipment.kind",
      "初始装备必须来自所选职业。",
    );
  const inventory: { id: string; quantity: number }[] = [];
  const add = (id: string, quantity = 1) => {
    const existing = inventory.find((item) => item.id === id);
    if (existing) existing.quantity += quantity;
    else inventory.push({ id, quantity });
  };
  let armorId: "none" | "leather" | "chain-mail" = "none";
  let normalizedEquipment: EquipmentInput;
  let pack: PackId;
  if (equipment.kind === "fighter") {
    if (!["chain-mail", "leather-longbow"].includes(equipment.armorPackage))
      fail(
        "invalid_option",
        "equipment.armorPackage",
        "请选择锁子甲或皮甲与长弓套装。",
      );
    armorId =
      equipment.armorPackage === "chain-mail" ? "chain-mail" : "leather";
    add(armorId);
    if (equipment.armorPackage === "leather-longbow") {
      add("longbow");
      add("arrows", 20);
    }
    if (!["weapon-shield", "two-weapons"].includes(equipment.weaponPackage))
      fail(
        "invalid_option",
        "equipment.weaponPackage",
        "请选择武器与盾或两把军用武器。",
      );
    const count = equipment.weaponPackage === "weapon-shield" ? 1 : 2;
    if (
      !Array.isArray(equipment.martialWeapons) ||
      equipment.martialWeapons.length !== count
    )
      fail(
        "invalid_choice_count",
        "equipment.martialWeapons",
        `请选择 ${count} 把军用武器。`,
      );
    for (const id of equipment.martialWeapons) {
      option(id, WEAPON_OPTIONS, "equipment.martialWeapons");
      if (WEAPON_OPTIONS[id].category !== "martial")
        fail(
          "invalid_weapon_category",
          "equipment.martialWeapons",
          "此处必须选择军用武器。",
        );
      add(id);
    }
    if (equipment.weaponPackage === "weapon-shield") add("shield");
    if (equipment.extraWeapons === "light-crossbow") {
      add("light-crossbow");
      add("bolts", 20);
    } else if (equipment.extraWeapons === "two-handaxes") add("handaxe", 2);
    else
      fail(
        "invalid_option",
        "equipment.extraWeapons",
        "请选择轻弩套装或两把手斧。",
      );
    if (!["dungeoneer", "explorer"].includes(equipment.pack))
      fail(
        "invalid_option",
        "equipment.pack",
        "此职业可选择地城探索包或野外探索包。",
      );
    pack = equipment.pack;
    normalizedEquipment = {
      kind: "fighter",
      armorPackage: equipment.armorPackage,
      weaponPackage: equipment.weaponPackage,
      martialWeapons: [...equipment.martialWeapons],
      extraWeapons: equipment.extraWeapons,
      pack: equipment.pack,
    };
  } else if (equipment.kind === "rogue") {
    if (!["rapier", "shortsword"].includes(equipment.primaryWeapon))
      fail("invalid_option", "equipment.primaryWeapon", "请选择细剑或短剑。");
    if (!["shortbow", "shortsword"].includes(equipment.secondaryWeapon))
      fail(
        "invalid_option",
        "equipment.secondaryWeapon",
        "请选择短弓套装或短剑。",
      );
    add(equipment.primaryWeapon);
    add(equipment.secondaryWeapon);
    if (equipment.secondaryWeapon === "shortbow") add("arrows", 20);
    add("leather");
    add("dagger", 2);
    add("thieves-tools");
    armorId = "leather";
    if (!["burglar", "dungeoneer", "explorer"].includes(equipment.pack))
      fail("invalid_option", "equipment.pack", "请选择受支持的游荡者背包。");
    pack = equipment.pack;
    normalizedEquipment = {
      kind: "rogue",
      primaryWeapon: equipment.primaryWeapon,
      secondaryWeapon: equipment.secondaryWeapon,
      pack: equipment.pack,
    };
  } else {
    if (!["quarterstaff", "dagger"].includes(equipment.primaryWeapon))
      fail("invalid_option", "equipment.primaryWeapon", "请选择长棍或匕首。");
    if (!["component-pouch", "arcane-focus"].includes(equipment.focus))
      fail("invalid_option", "equipment.focus", "请选择材料包或奥术法器。");
    if (!["scholar", "explorer"].includes(equipment.pack))
      fail("invalid_option", "equipment.pack", "请选择学者包或野外探索包。");
    add(equipment.primaryWeapon);
    add(equipment.focus);
    add("spellbook");
    pack = equipment.pack;
    normalizedEquipment = {
      kind: "wizard",
      primaryWeapon: equipment.primaryWeapon,
      focus: equipment.focus,
      pack: equipment.pack,
    };
  }
  for (const item of PACK_CONTENTS[pack]) add(item.id, item.quantity);
  // Custom backgrounds use a common starting allowance instead of importing non-SRD presets.
  add("common-clothes");
  add("pouch");
  add("gold", 15);
  if (input.backgroundId === "acolyte") {
    add("holy-symbol");
    add("prayer-book");
    add("incense", 5);
    add("vestments");
  }
  option(input.equippedWeaponId, WEAPON_OPTIONS, "equippedWeaponId");
  if (!inventory.some((item) => item.id === input.equippedWeaponId))
    fail(
      "weapon_not_owned",
      "equippedWeaponId",
      "只能装备本次初始装备中拥有的武器。",
    );
  if (typeof input.shieldEquipped !== "boolean")
    fail("invalid_option", "shieldEquipped", "持盾状态必须明确。");
  if (input.shieldEquipped && !inventory.some((item) => item.id === "shield"))
    fail("shield_not_owned", "shieldEquipped", "初始装备没有盾牌。");
  return { inventory, armorId, normalizedEquipment };
}
function weaponProficiencies(
  classId: HeroClass,
  speciesId: SpeciesId,
): WeaponId[] {
  const catalog = Object.keys(WEAPON_OPTIONS) as WeaponId[];
  const classWeapons: WeaponId[] =
    classId === "fighter"
      ? catalog
      : classId === "rogue"
        ? catalog.filter(
            (id) =>
              WEAPON_OPTIONS[id].category === "simple" ||
              ["longsword", "rapier", "shortsword"].includes(id),
          )
        : ["dagger", "quarterstaff", "light-crossbow"];
  const racialWeapons: WeaponId[] =
    speciesId === "high-elf"
      ? ["longsword", "shortsword", "shortbow", "longbow"]
      : speciesId === "hill-dwarf"
        ? ["battleaxe", "handaxe", "warhammer"]
        : [];
  return [...new Set([...classWeapons, ...racialWeapons])];
}
function resolveWeapon(
  input: HeroBuildInput,
  abilities: Record<Ability, number>,
  proficiencies: WeaponId[],
): WeaponProfile {
  const weapon = WEAPON_OPTIONS[input.equippedWeaponId];
  if (!["one-handed", "two-handed"].includes(input.weaponGrip))
    fail("invalid_option", "weaponGrip", "请选择单手或双手持握。");
  const twoHanded = input.weaponGrip === "two-handed";
  if (weapon.properties.includes("two-handed") && !twoHanded)
    fail("weapon_requires_two_hands", "weaponGrip", "此武器需要双手使用。");
  if (
    twoHanded &&
    !weapon.properties.some((property) =>
      ["versatile", "two-handed"].includes(property),
    )
  )
    fail("invalid_weapon_grip", "weaponGrip", "此武器没有双手或多用属性。");
  if (twoHanded && input.shieldEquipped)
    fail(
      "shield_hand_conflict",
      "shieldEquipped",
      "双手使用武器时不能同时持盾。",
    );
  const attackMode = input.attackMode ?? weapon.kind;
  if (!["melee", "ranged"].includes(attackMode))
    fail("invalid_option", "attackMode", "请选择近战或远程攻击。");
  if (
    (weapon.kind === "ranged" && attackMode !== "ranged") ||
    (weapon.kind === "melee" &&
      attackMode === "ranged" &&
      !weapon.properties.includes("thrown"))
  ) {
    fail("invalid_attack_mode", "attackMode", "此武器不支持所选攻击方式。");
  }
  let ability: Ability = weapon.kind === "ranged" ? "DEX" : "STR";
  if (weapon.properties.includes("finesse") && abilities.DEX > abilities.STR)
    ability = "DEX";
  const modifier = buildAbilityModifier(abilities[ability]);
  const proficient = proficiencies.includes(input.equippedWeaponId);
  const archery =
    input.fightingStyle === "archery" && weapon.kind === "ranged" ? 2 : 0;
  const dueling =
    input.fightingStyle === "dueling" && weapon.kind === "melee" && !twoHanded
      ? 2
      : 0;
  return {
    id: input.equippedWeaponId,
    name: weapon.name,
    ability,
    attackBonus: modifier + (proficient ? 2 : 0) + archery,
    damageBonus: modifier + dueling,
    damageDie:
      twoHanded && weapon.versatileDie ? weapon.versatileDie : weapon.damageDie,
    damageDice: weapon.damageDice,
    damageType: weapon.damageType,
    kind: weapon.kind,
    attackMode,
    proficient,
    properties: [...weapon.properties],
    ...(attackMode === "ranged" && weapon.range
      ? { range: { ...weapon.range } }
      : {}),
    disadvantageReasons:
      SPECIES_OPTIONS[input.speciesId].size === "Small" &&
      weapon.properties.includes("heavy")
        ? ["small-heavy-weapon"]
        : [],
  };
}

/** Build all mechanical values on the server; request fields never provide HP, AC, or bonuses. */
export function buildHero(input: HeroBuildInput): Hero {
  record(input, "input");
  const id = text(input.id, "id", 100);
  const name = text(input.name, "name", BUILDER_LIMITS.name);
  option(input.classId, CLASS_OPTIONS, "classId");
  option(input.speciesId, SPECIES_OPTIONS, "speciesId");
  option(input.backgroundId, BACKGROUND_OPTIONS, "backgroundId");
  validateScores(input);
  const profile = parseProfile(input.profile);
  const species = SPECIES_OPTIONS[input.speciesId],
    heroClass = CLASS_OPTIONS[input.classId];
  const abilities = Object.fromEntries(
    (Object.keys(ABILITY_OPTIONS) as Ability[]).map((ability) => [
      ability,
      input.baseScores[ability] + (species.bonuses[ability] ?? 0),
    ]),
  ) as Record<Ability, number>;
  choices(input.backgroundSkills, BUILDER_SKILLS, 2, "backgroundSkills");
  const classPool = Object.fromEntries(
    heroClass.skills.map((skill) => [skill, BUILDER_SKILLS[skill]]),
  );
  choices(input.classSkills, classPool, heroClass.skillCount, "classSkills");
  const skills = [
    ...species.skills,
    ...input.backgroundSkills,
    ...input.classSkills,
  ];
  if (new Set(skills).size !== skills.length)
    fail(
      "duplicate_proficiency",
      "skills",
      "种族、背景与职业不能重复选择技能；请改选同类技能。",
    );
  const expertise = input.expertise ?? [];
  choices(
    expertise,
    BUILDER_SKILLS,
    input.classId === "rogue" ? 2 : 0,
    "expertise",
  );
  if (expertise.some((skill) => !skills.includes(skill)))
    fail(
      "expertise_not_proficient",
      "expertise",
      "专精只能选择已经熟练的技能。",
    );
  if (input.classId === "fighter")
    option(input.fightingStyle, FIGHTING_STYLE_OPTIONS, "fightingStyle");
  else if (input.fightingStyle !== undefined)
    fail("wrong_class_feature", "fightingStyle", "只有战士能选择战斗风格。");
  const languages = [...species.languages];
  if (species.extraLanguage) {
    option(input.speciesLanguage, LANGUAGE_OPTIONS, "speciesLanguage");
    languages.push(input.speciesLanguage);
  } else if (input.speciesLanguage !== undefined)
    fail(
      "wrong_species_feature",
      "speciesLanguage",
      "此种族没有额外语言选择。",
    );
  const toolProficiencies: ToolId[] =
    input.classId === "rogue" ? ["thieves"] : [];
  if (input.speciesId === "hill-dwarf") {
    option(
      input.dwarfTool,
      { smith: true, brewer: true, mason: true },
      "dwarfTool",
    );
    toolProficiencies.push(input.dwarfTool);
  } else if (input.dwarfTool !== undefined)
    fail(
      "wrong_species_feature",
      "dwarfTool",
      "只有矮人能选择这项种族工具熟练。",
    );
  if (
    !Array.isArray(input.backgroundExtras) ||
    input.backgroundExtras.length !== 2
  )
    fail(
      "invalid_choice_count",
      "backgroundExtras",
      "背景需要合计两项工具熟练或语言。",
    );
  for (const extra of input.backgroundExtras) {
    if (typeof extra !== "string")
      fail("invalid_option", "backgroundExtras", "请选择工具熟练或语言。");
    const [kind, choice, ...rest] = extra.split(":");
    if (rest.length)
      fail("invalid_option", "backgroundExtras", "请选择工具熟练或语言。");
    if (kind === "language") {
      option(choice, LANGUAGE_OPTIONS, "backgroundExtras");
      languages.push(choice);
    } else if (kind === "tool") {
      option(choice, TOOL_OPTIONS, "backgroundExtras");
      toolProficiencies.push(choice);
    } else fail("invalid_option", "backgroundExtras", "请选择工具熟练或语言。");
  }
  if (
    new Set(languages).size !== languages.length ||
    new Set(toolProficiencies).size !== toolProficiencies.length
  )
    fail(
      "duplicate_proficiency",
      "backgroundExtras",
      "语言和工具不能重复选择；请换一种。",
    );
  // Acolyte's published package grants languages; other mixes use a custom background.
  if (
    input.backgroundId === "acolyte" &&
    input.backgroundExtras.some((extra) => !extra.startsWith("language:"))
  )
    fail(
      "invalid_acolyte_extras",
      "backgroundExtras",
      "侍僧背景选择两门语言；工具选项请使用自定义背景。",
    );
  const cantrips = input.cantrips ?? [],
    spellbook = input.spellbook ?? [],
    preparedSpells = input.preparedSpells ?? [];
  choices(
    cantrips,
    CANTRIP_OPTIONS,
    input.classId === "wizard" ? 3 : 0,
    "cantrips",
  );
  choices(
    spellbook,
    FIRST_LEVEL_SPELL_OPTIONS,
    input.classId === "wizard" ? 6 : 0,
    "spellbook",
  );
  const preparationCount =
    input.classId === "wizard"
      ? Math.max(1, buildAbilityModifier(abilities.INT) + 1)
      : 0;
  choices(
    preparedSpells,
    FIRST_LEVEL_SPELL_OPTIONS,
    preparationCount,
    "preparedSpells",
  );
  if (preparedSpells.some((spell) => !spellbook.includes(spell)))
    fail(
      "spell_not_in_book",
      "preparedSpells",
      "准备法术必须来自自己的法术书。",
    );
  if (input.speciesId === "high-elf") {
    option(input.racialCantrip, CANTRIP_OPTIONS, "racialCantrip");
    if (cantrips.includes(input.racialCantrip))
      fail(
        "duplicate_cantrip",
        "racialCantrip",
        "种族戏法请选一个不同于职业戏法的选项。",
      );
  } else if (input.racialCantrip !== undefined)
    fail(
      "wrong_species_feature",
      "racialCantrip",
      "只有高等精灵有此种族戏法选择。",
    );
  const { inventory, armorId, normalizedEquipment } = resolveEquipment(input);
  const proficiencies = weaponProficiencies(input.classId, input.speciesId),
    weapon = resolveWeapon(input, abilities, proficiencies);
  const armorAc =
    armorId === "chain-mail"
      ? 16
      : (armorId === "leather" ? 11 : 10) + buildAbilityModifier(abilities.DEX);
  const ac =
    armorAc +
    (input.shieldEquipped ? 2 : 0) +
    (input.fightingStyle === "defense" && armorId !== "none" ? 1 : 0);
  const hp =
    heroClass.hitDie +
    buildAbilityModifier(abilities.CON) +
    (input.speciesId === "hill-dwarf" ? 1 : 0);
  const speed =
    species.speed -
    (armorId === "chain-mail" &&
    abilities.STR < 13 &&
    input.speciesId !== "hill-dwarf"
      ? 10
      : 0);
  return {
    id,
    name,
    classId: input.classId,
    species: species.name,
    background:
      profile.backstory || BACKGROUND_OPTIONS[input.backgroundId].description,
    abilities,
    skills,
    hp,
    maxHp: hp,
    ac,
    potions: 0,
    hitDice: 1,
    secondWind: input.classId === "fighter" ? 1 : 0,
    spellSlots: input.classId === "wizard" ? 2 : 0,
    build: {
      rulesVersion: TABLE_RULES_VERSION,
      level: 1,
      abilityMethod: input.abilityMethod,
      baseScores: { ...input.baseScores },
      speciesId: input.speciesId,
      ...(input.speciesLanguage
        ? { speciesLanguage: input.speciesLanguage }
        : {}),
      ...(input.dwarfTool ? { dwarfTool: input.dwarfTool } : {}),
      backgroundId: input.backgroundId,
      backgroundSkills: [...input.backgroundSkills],
      backgroundExtras: [...input.backgroundExtras],
      classSkills: [...input.classSkills],
      expertise: [...expertise],
      ...(input.fightingStyle ? { fightingStyle: input.fightingStyle } : {}),
      equipment: normalizedEquipment,
      equippedWeaponId: input.equippedWeaponId,
      weaponGrip: input.weaponGrip,
      shieldEquipped: input.shieldEquipped,
      inventory,
      weapon,
      armorId,
      armorStealthDisadvantage: armorId === "chain-mail",
      proficiencyBonus: 2,
      savingThrowProficiencies: [...heroClass.saves],
      weaponProficiencies: proficiencies,
      toolProficiencies,
      languages,
      speed,
      size: species.size,
      darkvision: species.darkvision,
      traits: [...species.traits],
      ...(input.racialCantrip ? { racialCantrip: input.racialCantrip } : {}),
      cantrips: [...cantrips],
      spellbook: [...spellbook],
      preparedSpells: [...preparedSpells],
      spellAttackBonus: buildAbilityModifier(abilities.INT) + 2,
      spellSaveDc: 10 + buildAbilityModifier(abilities.INT),
      spellSlotMaximum: input.classId === "wizard" ? 2 : 0,
      arcaneRecovery: input.classId === "wizard" ? 1 : 0,
      profile,
    },
  };
}

/** Defaults are editable examples, not an alternate rules authority. */
export function createDefaultHeroInput(
  classId: HeroClass,
  id = "preview",
  name = "新冒险者",
  speciesId: SpeciesId = "human",
): HeroBuildInput {
  option(classId, CLASS_OPTIONS, "classId");
  option(speciesId, SPECIES_OPTIONS, "speciesId");
  const backgrounds: Record<HeroClass, BackgroundId> = {
    fighter: "watch-keeper",
    rogue: "traveler",
    wizard: "archivist",
  };
  const scores: Record<HeroClass, Record<Ability, number>> = {
    fighter: { STR: 15, DEX: 12, CON: 14, INT: 10, WIS: 13, CHA: 8 },
    rogue: { STR: 8, DEX: 15, CON: 13, INT: 12, WIS: 14, CHA: 10 },
    wizard: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 },
  };
  const species = SPECIES_OPTIONS[speciesId],
    backgroundId = backgrounds[classId];
  const backgroundSkills = [...BACKGROUND_OPTIONS[backgroundId].skills];
  for (let index = 0; index < backgroundSkills.length; index++)
    if (species.skills.includes(backgroundSkills[index])) {
      backgroundSkills[index] = (Object.keys(BUILDER_SKILLS) as Skill[]).find(
        (skill) =>
          !species.skills.includes(skill) && !backgroundSkills.includes(skill),
      )!;
    }
  const preferred: Record<HeroClass, Skill[]> = {
    fighter: ["insight", "intimidation"],
    rogue: ["stealth", "investigation", "acrobatics", "insight"],
    wizard: ["investigation", "insight"],
  };
  const classSkills = [...preferred[classId], ...CLASS_OPTIONS[classId].skills]
    .filter(
      (skill, index, all) =>
        all.indexOf(skill) === index &&
        !species.skills.includes(skill) &&
        !backgroundSkills.includes(skill),
    )
    .slice(0, CLASS_OPTIONS[classId].skillCount);
  const equipment: EquipmentInput =
    classId === "fighter"
      ? {
          kind: "fighter",
          armorPackage: "chain-mail",
          weaponPackage: "weapon-shield",
          martialWeapons: ["longsword"],
          extraWeapons: "light-crossbow",
          pack: "dungeoneer",
        }
      : classId === "rogue"
        ? {
            kind: "rogue",
            primaryWeapon: "rapier",
            secondaryWeapon: "shortbow",
            pack: "burglar",
          }
        : {
            kind: "wizard",
            primaryWeapon: "quarterstaff",
            focus: "arcane-focus",
            pack: "scholar",
          };
  const cantrips: CantripId[] =
    classId === "wizard" ? ["fire-bolt", "light", "mage-hand"] : [];
  const spellbook: FirstLevelSpellId[] =
    classId === "wizard"
      ? [
          "magic-missile",
          "mage-armor",
          "sleep",
          "burning-hands",
          "disguise-self",
          "comprehend-languages",
        ]
      : [];
  const languagePool = (Object.keys(LANGUAGE_OPTIONS) as LanguageId[]).filter(
    (language) => !species.languages.includes(language),
  );
  const speciesLanguage = species.extraLanguage
    ? languagePool.shift()!
    : undefined;
  const backgroundExtras: BackgroundExtra[] = languagePool
    .slice(0, 2)
    .map((language) => `language:${language}` as BackgroundExtra);
  const intelligence = scores[classId].INT + (species.bonuses.INT ?? 0);
  return {
    id,
    name,
    classId,
    speciesId,
    abilityMethod: "standard-array",
    baseScores: { ...scores[classId] },
    backgroundId,
    backgroundSkills,
    backgroundExtras,
    classSkills,
    ...(classId === "rogue"
      ? { expertise: ["stealth", "investigation"] as Skill[] }
      : {}),
    ...(classId === "fighter"
      ? { fightingStyle: "defense" as FightingStyle }
      : {}),
    ...(speciesLanguage ? { speciesLanguage } : {}),
    ...(speciesId === "hill-dwarf" ? { dwarfTool: "mason" as const } : {}),
    ...(speciesId === "high-elf"
      ? {
          racialCantrip: (Object.keys(CANTRIP_OPTIONS) as CantripId[]).find(
            (spell) => !cantrips.includes(spell),
          )!,
        }
      : {}),
    equipment,
    equippedWeaponId:
      classId === "fighter"
        ? "longsword"
        : classId === "rogue"
          ? "rapier"
          : "quarterstaff",
    weaponGrip: "one-handed",
    shieldEquipped: classId === "fighter",
    cantrips,
    spellbook,
    preparedSpells: spellbook.slice(
      0,
      Math.max(1, buildAbilityModifier(intelligence) + 1),
    ),
    profile: {
      personality: ["我会先观察，再决定下一步。", "我愿意听完同行者的建议。"],
      ideal: "用自己的本领帮助需要帮助的人。",
      bond: "家乡的一位旧识仍在等我带回消息。",
      flaw: "我很难承认自己对未知感到害怕。",
      goal: "完成第一份委托，并发现值得追寻的答案。",
      cooperation: "同行者有我欠缺的本领，我愿意一起承担风险。",
      backstory: "第一次离开熟悉的地方，寻找自己的道路。",
    },
  };
}
