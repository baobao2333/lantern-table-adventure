"use client";
import { useState } from "react";
import {
  buildHero,
  createDefaultHeroInput,
  ABILITY_OPTIONS,
  BACKGROUND_OPTIONS,
  BUILDER_SKILLS,
  CLASS_OPTIONS,
  SPECIES_OPTIONS,
  STANDARD_ARRAY,
  pointBuyCost,
  WEAPON_OPTIONS,
  FIGHTING_STYLE_OPTIONS,
  CANTRIP_OPTIONS,
  FIRST_LEVEL_SPELL_OPTIONS,
  LANGUAGE_OPTIONS,
  TOOL_OPTIONS,
  PACK_OPTIONS,
} from "@/lib/game/character-builder";
import type {
  Ability,
  BackgroundExtra,
  BackgroundId,
  CantripId,
  FirstLevelSpellId,
  HeroBuildInput,
  HeroClass,
  Skill,
  SpeciesId,
  WeaponId,
} from "@/lib/game/types";
import { sign } from "./components";

export function CharacterBuilder({
  value,
  onChange,
  disabled = false,
}: {
  value: HeroBuildInput;
  onChange: (value: HeroBuildInput) => void;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState("identity");
  const update = (patch: Partial<HeroBuildInput>) =>
    onChange({ ...value, ...patch });
  let preview = null,
    issue = "";
  try {
    preview = buildHero(value);
  } catch (e) {
    issue = e instanceof Error ? e.message : "请完成角色选择。";
  }
  const profile = (field: keyof HeroBuildInput["profile"], text: string) =>
    update({ profile: { ...value.profile, [field]: text } });
  const changeClass = (classId: HeroClass, speciesId = value.speciesId) =>
    onChange({
      ...createDefaultHeroInput(classId, "preview", value.name, speciesId),
      profile: value.profile,
    });
  const allSkills = Object.keys(BUILDER_SKILLS) as Skill[];
  const toggleSkill = (
    field: "backgroundSkills" | "classSkills" | "expertise",
    skill: Skill,
    count: number,
  ) => {
    const list = value[field] || [],
      next = list.includes(skill)
        ? list.filter((s) => s !== skill)
        : list.length < count
          ? [...list, skill]
          : list;
    update({
      [field]: next,
      ...(field !== "expertise"
        ? {
            expertise: value.expertise?.filter((s) =>
              [
                ...value.backgroundSkills,
                ...value.classSkills,
                ...next,
              ].includes(s),
            ),
          }
        : {}),
    });
  };
  const toggleSpell = (
    field: "cantrips" | "spellbook" | "preparedSpells",
    id: string,
    count: number,
  ) => {
    const list = value[field] || [],
      next = list.includes(id as never)
        ? list.filter((s) => s !== id)
        : list.length < count
          ? [...list, id]
          : list;
    update({
      [field]: next,
      ...(field === "spellbook"
        ? {
            preparedSpells: value.preparedSpells?.filter((s) =>
              next.includes(s),
            ),
          }
        : {}),
    } as Partial<HeroBuildInput>);
  };
  const skillGrid = (
    field: "backgroundSkills" | "classSkills" | "expertise",
    pool: Skill[],
    count: number,
  ) => (
    <div className="choice-grid">
      {pool.map((skill) => (
        <label className="check-choice" key={skill}>
          <input
            type="checkbox"
            checked={(value[field] || []).includes(skill)}
            disabled={disabled}
            onChange={() => toggleSkill(field, skill, count)}
          />
          <span>
            {BUILDER_SKILLS[skill].name}
            <small>{BUILDER_SKILLS[skill].ability}</small>
          </span>
        </label>
      ))}
    </div>
  );
  const gear = value.equipment;
  const equipped: WeaponId[] =
    gear.kind === "fighter"
      ? [
          ...gear.martialWeapons,
          ...(gear.armorPackage === "leather-longbow"
            ? ["longbow" as const]
            : []),
          ...(gear.extraWeapons === "light-crossbow"
            ? ["light-crossbow" as const]
            : ["handaxe" as const]),
        ]
      : gear.kind === "rogue"
        ? [gear.primaryWeapon, gear.secondaryWeapon, "dagger"]
        : [gear.primaryWeapon];
  const tabs = [
    { id: "identity", name: "身份" },
    { id: "abilities", name: "属性" },
    { id: "skills", name: "熟练" },
    { id: "equipment", name: "装备" },
    { id: "spells", name: "法术" },
    { id: "profile", name: "人物" },
  ];
  return (
    <div className="builder">
      <div className="builder-tabs" role="tablist" aria-label="角色编辑步骤">
        {tabs.map((t) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            key={t.id}
            onClick={() => setTab(t.id)}
            className={tab === t.id ? "selected" : ""}
          >
            {t.name}
          </button>
        ))}
      </div>
      {tab === "identity" && (
        <>
          <label className="field">
            名字
            <input
              value={value.name}
              maxLength={24}
              disabled={disabled}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <div className="builder-columns">
            <label className="field">
              职业
              <select
                value={value.classId}
                onChange={(e) => changeClass(e.target.value as HeroClass)}
                disabled={disabled}
              >
                {Object.entries(CLASS_OPTIONS).map(([id, c]) => (
                  <option value={id} key={id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              种族
              <select
                value={value.speciesId}
                onChange={(e) =>
                  changeClass(value.classId, e.target.value as SpeciesId)
                }
                disabled={disabled}
              >
                {Object.entries(SPECIES_OPTIONS).map(([id, s]) => (
                  <option key={id} value={id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="scope-note">
            {CLASS_OPTIONS[value.classId].description}
          </p>
          <p className="subtle-note">
            {SPECIES_OPTIONS[value.speciesId].description}
          </p>
          <label className="field">
            背景
            <select
              disabled={disabled}
              value={value.backgroundId}
              onChange={(e) =>
                update({
                  backgroundId: e.target.value as BackgroundId,
                  backgroundSkills: [
                    ...BACKGROUND_OPTIONS[e.target.value as BackgroundId]
                      .skills,
                  ],
                })
              }
            >
              {Object.entries(BACKGROUND_OPTIONS).map(([id, b]) => (
                <option key={id} value={id}>
                  {b.name}
                  {b.source === "custom" ? " · 原创" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="subtle-note">
            {BACKGROUND_OPTIONS[value.backgroundId].description}
          </p>
          <p>身份可以大胆创作，实际能力由这张一级角色卡决定。</p>
        </>
      )}
      {tab === "abilities" && (
        <>
          <label className="field">
            属性生成
            <select
              disabled={disabled}
              value={value.abilityMethod}
              onChange={(e) =>
                update({
                  abilityMethod: e.target
                    .value as HeroBuildInput["abilityMethod"],
                })
              }
            >
              <option value="standard-array">
                标准数组 · 15 / 14 / 13 / 12 / 10 / 8
              </option>
              <option value="point-buy">27 点购点 · 种族修正前 8–15</option>
            </select>
          </label>
          <div className="builder-abilities">
            {(Object.keys(ABILITY_OPTIONS) as Ability[]).map((a) => (
              <label className="field" key={a}>
                {ABILITY_OPTIONS[a]}
                <select
                  disabled={disabled}
                  value={value.baseScores[a]}
                  onChange={(e) => {
                    const n = Number(e.target.value),
                      scores = { ...value.baseScores };
                    if (value.abilityMethod === "standard-array") {
                      const other = (Object.keys(scores) as Ability[]).find(
                        (k) => k !== a && scores[k] === n,
                      );
                      if (other) scores[other] = scores[a];
                    }
                    scores[a] = n;
                    update({ baseScores: scores });
                  }}
                >
                  {(value.abilityMethod === "standard-array"
                    ? STANDARD_ARRAY
                    : [8, 9, 10, 11, 12, 13, 14, 15]
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <small>
                  种族 {sign(SPECIES_OPTIONS[value.speciesId].bonuses[a] || 0)}{" "}
                  →{" "}
                  {value.baseScores[a] +
                    (SPECIES_OPTIONS[value.speciesId].bonuses[a] || 0)}
                </small>
              </label>
            ))}
          </div>
          {value.abilityMethod === "point-buy" && (
            <p>
              购点已用 {pointBuyCost(value.baseScores)} / 27。可保留未使用点数。
            </p>
          )}
          <p className="subtle-note">
            数值影响检定、生命、护甲与攻击。标准数组改选数值时会交换位置。
          </p>
        </>
      )}
      {tab === "skills" && (
        <>
          <h3>背景技能 · 选 2 项</h3>
          {skillGrid("backgroundSkills", allSkills, 2)}
          <h3>职业技能 · 选 {CLASS_OPTIONS[value.classId].skillCount} 项</h3>
          {skillGrid(
            "classSkills",
            CLASS_OPTIONS[value.classId].skills,
            CLASS_OPTIONS[value.classId].skillCount,
          )}
          {value.classId === "rogue" && (
            <>
              <h3>技能专精 · 从已熟练技能选 2 项</h3>
              {skillGrid(
                "expertise",
                [
                  ...new Set([
                    ...value.backgroundSkills,
                    ...value.classSkills,
                    ...SPECIES_OPTIONS[value.speciesId].skills,
                  ]),
                ],
                2,
              )}
            </>
          )}
          <h3>背景工具与语言 · 合计 2 项</h3>
          <div className="builder-columns">
            {[0, 1].map((i) => (
              <label className="field" key={i}>
                选择 {i + 1}
                <select
                  disabled={disabled}
                  value={value.backgroundExtras[i] || ""}
                  onChange={(e) => {
                    const next = [...value.backgroundExtras];
                    next[i] = e.target.value as BackgroundExtra;
                    update({ backgroundExtras: next });
                  }}
                >
                  {Object.entries(LANGUAGE_OPTIONS).map(([id, label]) => (
                    <option value={`language:${id}`} key={id}>
                      语言 · {label}
                    </option>
                  ))}
                  {value.backgroundId !== "acolyte" &&
                    Object.entries(TOOL_OPTIONS).map(([id, label]) => (
                      <option value={`tool:${id}`} key={id}>
                        工具 · {label}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          {SPECIES_OPTIONS[value.speciesId].extraLanguage && (
            <label className="field">
              种族额外语言
              <select
                disabled={disabled}
                value={value.speciesLanguage}
                onChange={(e) =>
                  update({
                    speciesLanguage: e.target
                      .value as HeroBuildInput["speciesLanguage"],
                  })
                }
              >
                {Object.entries(LANGUAGE_OPTIONS).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {value.speciesId === "hill-dwarf" && (
            <label className="field">
              矮人工具
              <select
                value={value.dwarfTool}
                onChange={(e) =>
                  update({
                    dwarfTool: e.target.value as HeroBuildInput["dwarfTool"],
                  })
                }
              >
                {["smith", "brewer", "mason"].map((id) => (
                  <option key={id} value={id}>
                    {TOOL_OPTIONS[id as keyof typeof TOOL_OPTIONS]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="subtle-note">
            技能、语言和工具不能重复。熟练 +2；专精改为 +4，不叠加。
          </p>
        </>
      )}
      {tab === "equipment" && (
        <>
          {gear.kind === "fighter" && (
            <>
              <label className="field">
                战斗风格
                <select
                  disabled={disabled}
                  value={value.fightingStyle}
                  onChange={(e) =>
                    update({
                      fightingStyle: e.target
                        .value as HeroBuildInput["fightingStyle"],
                    })
                  }
                >
                  {Object.entries(FIGHTING_STYLE_OPTIONS).map(([id, s]) => (
                    <option value={id} key={id}>
                      {s.name} · {s.effect}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                护甲套装
                <select
                  value={gear.armorPackage}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        armorPackage: e.target
                          .value as typeof gear.armorPackage,
                      },
                    })
                  }
                >
                  <option value="chain-mail">锁子甲</option>
                  <option value="leather-longbow">皮甲、长弓与箭</option>
                </select>
              </label>
              <label className="field">
                军用武器套装
                <select
                  value={gear.weaponPackage}
                  onChange={(e) => {
                    const shield = e.target.value === "weapon-shield";
                    update({
                      equipment: {
                        ...gear,
                        weaponPackage: shield ? "weapon-shield" : "two-weapons",
                        martialWeapons: shield
                          ? [gear.martialWeapons[0]]
                          : [gear.martialWeapons[0], "shortsword"],
                      },
                      shieldEquipped: shield,
                      weaponGrip: "one-handed",
                    });
                  }}
                >
                  <option value="weapon-shield">一把军用武器与盾</option>
                  <option value="two-weapons">两把军用武器</option>
                </select>
              </label>
              {gear.martialWeapons.map((id, i) => (
                <label className="field" key={i}>
                  军用武器 {i + 1}
                  <select
                    value={id}
                    onChange={(e) => {
                      const next = [...gear.martialWeapons];
                      next[i] = e.target.value as WeaponId;
                      update({
                        equipment: { ...gear, martialWeapons: next },
                        ...(i === 0
                          ? {
                              equippedWeaponId: next[0],
                              shieldEquipped:
                                !WEAPON_OPTIONS[next[0]].properties.includes(
                                  "two-handed",
                                ) && gear.weaponPackage === "weapon-shield",
                              weaponGrip: WEAPON_OPTIONS[
                                next[0]
                              ].properties.includes("two-handed")
                                ? "two-handed"
                                : "one-handed",
                            }
                          : {}),
                      });
                    }}
                  >
                    {Object.entries(WEAPON_OPTIONS)
                      .filter(([, w]) => w.category === "martial")
                      .map(([id, w]) => (
                        <option key={id} value={id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <label className="field">
                备用武器
                <select
                  value={gear.extraWeapons}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        extraWeapons: e.target
                          .value as typeof gear.extraWeapons,
                      },
                    })
                  }
                >
                  <option value="light-crossbow">轻弩与弩矢</option>
                  <option value="two-handaxes">两把手斧</option>
                </select>
              </label>
            </>
          )}
          {gear.kind === "rogue" && (
            <div className="builder-columns">
              <label className="field">
                主武器
                <select
                  value={gear.primaryWeapon}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        primaryWeapon: e.target
                          .value as typeof gear.primaryWeapon,
                      },
                      equippedWeaponId: e.target.value as WeaponId,
                    })
                  }
                >
                  <option value="rapier">细剑</option>
                  <option value="shortsword">短剑</option>
                </select>
              </label>
              <label className="field">
                备用武器
                <select
                  value={gear.secondaryWeapon}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        secondaryWeapon: e.target
                          .value as typeof gear.secondaryWeapon,
                      },
                    })
                  }
                >
                  <option value="shortbow">短弓与箭</option>
                  <option value="shortsword">短剑</option>
                </select>
              </label>
            </div>
          )}
          {gear.kind === "wizard" && (
            <>
              <label className="field">
                武器
                <select
                  value={gear.primaryWeapon}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        primaryWeapon: e.target
                          .value as typeof gear.primaryWeapon,
                      },
                      equippedWeaponId: e.target.value as WeaponId,
                    })
                  }
                >
                  <option value="quarterstaff">长棍</option>
                  <option value="dagger">匕首</option>
                </select>
              </label>
              <label className="field">
                施法媒介
                <select
                  value={gear.focus}
                  onChange={(e) =>
                    update({
                      equipment: {
                        ...gear,
                        focus: e.target.value as typeof gear.focus,
                      },
                    })
                  }
                >
                  <option value="arcane-focus">奥术法器</option>
                  <option value="component-pouch">材料包</option>
                </select>
              </label>
            </>
          )}
          <label className="field">
            行装
            <select
              value={gear.pack}
              onChange={(e) =>
                update({
                  equipment: { ...gear, pack: e.target.value } as typeof gear,
                })
              }
            >
              {Object.entries(PACK_OPTIONS)
                .filter(([id]) =>
                  gear.kind === "wizard"
                    ? ["scholar", "explorer"].includes(id)
                    : gear.kind === "fighter"
                      ? id !== "scholar" && id !== "burglar"
                      : id !== "scholar",
                )
                .map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            当前持用武器
            <select
              value={value.equippedWeaponId}
              onChange={(e) => {
                const id = e.target.value as WeaponId,
                  two = WEAPON_OPTIONS[id].properties.includes("two-handed");
                update({
                  equippedWeaponId: id,
                  weaponGrip: two ? "two-handed" : "one-handed",
                  shieldEquipped: two ? false : value.shieldEquipped,
                });
              }}
            >
              {[...new Set(equipped)].map((id) => (
                <option value={id} key={id}>
                  {WEAPON_OPTIONS[id].name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            握持
            <select
              value={value.weaponGrip}
              onChange={(e) =>
                update({
                  weaponGrip: e.target.value as HeroBuildInput["weaponGrip"],
                })
              }
            >
              <option value="one-handed">单手</option>
              <option value="two-handed">双手</option>
            </select>
          </label>
          {gear.kind === "fighter" &&
            gear.weaponPackage === "weapon-shield" && (
              <label className="check-choice">
                <input
                  type="checkbox"
                  checked={value.shieldEquipped}
                  onChange={(e) => update({ shieldEquipped: e.target.checked })}
                />
                持盾（双手武器不能同时持盾）
              </label>
            )}
          <p className="subtle-note">
            装备决定实际护甲和攻击；本版采用抽象距离，未实现格子移动与全部种族条件能力。
          </p>
        </>
      )}
      {tab === "spells" && (
        <>
          {value.classId === "wizard" ? (
            <>
              <h3>职业戏法 · 选 3 个</h3>
              <div className="choice-grid">
                {Object.entries(CANTRIP_OPTIONS).map(([id, s]) => (
                  <label className="check-choice" key={id}>
                    <input
                      type="checkbox"
                      checked={value.cantrips?.includes(id as CantripId)}
                      onChange={() => toggleSpell("cantrips", id, 3)}
                    />
                    <span>
                      {s.name}
                      <small>{s.description}</small>
                    </span>
                  </label>
                ))}
              </div>
              <h3>法术书 · 选 6 个</h3>
              <div className="choice-grid">
                {Object.entries(FIRST_LEVEL_SPELL_OPTIONS).map(([id, s]) => (
                  <label className="check-choice" key={id}>
                    <input
                      type="checkbox"
                      checked={value.spellbook?.includes(
                        id as FirstLevelSpellId,
                      )}
                      onChange={() => toggleSpell("spellbook", id, 6)}
                    />
                    <span>
                      {s.name}
                      <small>{s.description}</small>
                    </span>
                  </label>
                ))}
              </div>
              <h3>
                每日准备 · 选{" "}
                {Math.max(
                  1,
                  Math.floor(
                    (value.baseScores.INT +
                      (SPECIES_OPTIONS[value.speciesId].bonuses.INT || 0) -
                      10) /
                      2,
                  ) + 1,
                )}{" "}
                个
              </h3>
              <div className="choice-grid">
                {value.spellbook?.map((id) => (
                  <label className="check-choice" key={id}>
                    <input
                      type="checkbox"
                      checked={value.preparedSpells?.includes(id)}
                      onChange={() =>
                        toggleSpell(
                          "preparedSpells",
                          id,
                          Math.max(
                            1,
                            Math.floor(
                              (value.baseScores.INT +
                                (SPECIES_OPTIONS[value.speciesId].bonuses.INT ||
                                  0) -
                                10) /
                                2,
                            ) + 1,
                          ),
                        )
                      }
                    />
                    <span>{FIRST_LEVEL_SPELL_OPTIONS[id].name}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p>这个职业没有法术位。高等精灵仍可选择一个种族戏法。</p>
          )}
          {value.speciesId === "high-elf" && (
            <label className="field">
              种族戏法
              <select
                value={value.racialCantrip}
                onChange={(e) =>
                  update({ racialCantrip: e.target.value as CantripId })
                }
              >
                {Object.entries(CANTRIP_OPTIONS).map(([id, s]) => (
                  <option value={id} key={id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {tab === "profile" && (
        <>
          <div className="builder-columns">
            {[0, 1].map((i) => (
              <label className="field" key={i}>
                性格特点 {i + 1}
                <input
                  value={value.profile.personality[i]}
                  maxLength={180}
                  onChange={(e) => {
                    const next = [...value.profile.personality] as [
                      string,
                      string,
                    ];
                    next[i] = e.target.value;
                    update({
                      profile: { ...value.profile, personality: next },
                    });
                  }}
                />
              </label>
            ))}
          </div>
          {(
            [
              { id: "ideal", label: "理想" },
              { id: "bond", label: "羁绊 · 人或事" },
              { id: "flaw", label: "缺点" },
              { id: "goal", label: "当前目标" },
              { id: "cooperation", label: "为何愿意合作" },
              { id: "backstory", label: "经历与身份设定" },
            ] as const
          ).map((f) => (
            <label className="field" key={f.id}>
              {f.label}
              <textarea
                rows={f.id === "backstory" ? 3 : 2}
                maxLength={f.id === "backstory" ? 1200 : 300}
                value={value.profile[f.id]}
                onChange={(e) => profile(f.id, e.target.value)}
              />
            </label>
          ))}
          <p className="subtle-note">
            你可以是失去神力的古神，也可以是误认自己为神的普通人。DM
            会使用这些设定，但不会据此增加数值或特殊能力。
          </p>
        </>
      )}
      <div className="builder-preview" aria-live="polite">
        {preview ? (
          <>
            <strong>
              一级 {preview.species} · {CLASS_OPTIONS[preview.classId].name}
            </strong>
            <span>
              HP {preview.maxHp} · AC {preview.ac} ·{" "}
              {preview.build!.weapon.name}命中{" "}
              {sign(preview.build!.weapon.attackBonus)}
            </span>
            <small>所有数值会在保存时重新由服务器计算。</small>
          </>
        ) : (
          <span className="form-error">{issue}</span>
        )}
      </div>
    </div>
  );
}
