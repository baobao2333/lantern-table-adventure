"use client";
import { Heart, Shield } from "lucide-react";
import { ABILITIES, abilityMod, skillMod, SKILLS } from "@/lib/game/characters";
import {
  CANTRIP_OPTIONS,
  FIRST_LEVEL_SPELL_OPTIONS,
  INVENTORY_LABELS,
  LANGUAGE_OPTIONS,
  TOOL_OPTIONS,
} from "@/lib/game/character-builder";
import type { Ability, Hero } from "@/lib/game/types";
import { sign } from "./components";
export function CharacterDetails({ hero }: { hero: Hero }) {
  const build = hero.build;
  return (
    <>
      <div className="character-stats">
        <span>
          <Heart size={15} />
          {hero.maxHp}
          <small>生命</small>
        </span>
        <span>
          <Shield size={15} />
          {hero.ac}
          <small>护甲</small>
        </span>
        <span>
          +2<small>熟练</small>
        </span>
      </div>
      <details className="character-details">
        <summary>查看完整角色卡</summary>
        <div className="ability-grid">
          {Object.entries(hero.abilities).map(([key, value]) => (
            <div key={key}>
              <small>{ABILITIES[key as Ability]}</small>
              <strong>{sign(abilityMod(value))}</strong>
              <span>{value}</span>
            </div>
          ))}
        </div>
        <h4>熟练与专精</h4>
        <div className="skill-list">
          {hero.skills.map((skill) => (
            <span key={skill}>
              {SKILLS[skill].name}
              {build?.expertise.includes(skill) ? " · 专精" : ""}
              <strong>{sign(skillMod(hero, skill))}</strong>
            </span>
          ))}
        </div>
        {build && (
          <>
            <h4>装备与攻击</h4>
            <p>
              {build.weapon.name} · 命中 {sign(build.weapon.attackBonus)} ·{" "}
              {build.weapon.damageDice}d{build.weapon.damageDie}
              {sign(build.weapon.damageBonus)} 伤害
            </p>
            <p>
              速度 {build.speed} 尺 · {build.size === "Small" ? "小型" : "中型"}
              {build.darkvision ? ` · 黑暗视觉 ${build.darkvision} 尺` : ""}
            </p>
            <p>
              语言：
              {build.languages.map((id) => LANGUAGE_OPTIONS[id]).join("、")}
            </p>
            <p>
              工具：
              {build.toolProficiencies
                .map((id) => TOOL_OPTIONS[id])
                .join("、") || "无"}
            </p>
            <p className="inventory-line">
              {build.inventory
                .map(
                  (item) =>
                    `${INVENTORY_LABELS[item.id] || item.id} ×${item.quantity}`,
                )
                .join(" · ")}
            </p>
            {(build.cantrips.length > 0 || build.racialCantrip) && (
              <>
                <h4>戏法</h4>
                <p>
                  {[
                    ...new Set([
                      ...build.cantrips,
                      ...(build.racialCantrip ? [build.racialCantrip] : []),
                    ]),
                  ]
                    .map((id) => CANTRIP_OPTIONS[id].name)
                    .join("、")}
                </p>
              </>
            )}
            {build.spellbook.length > 0 && (
              <>
                <h4>法术书与准备</h4>
                <p>
                  法术攻击 {sign(build.spellAttackBonus)} · 豁免 DC{" "}
                  {build.spellSaveDc}
                </p>
                {build.spellbook.map((id) => (
                  <p key={id}>
                    {build.preparedSpells.includes(id)
                      ? "● 已准备"
                      : "○ 法术书"}{" "}
                    {FIRST_LEVEL_SPELL_OPTIONS[id].name}
                  </p>
                ))}
              </>
            )}
            <h4>人物设定</h4>
            <p>
              性格：
              {build.profile.personality.filter(Boolean).join("；") ||
                "留待旅途中发现"}
            </p>
            {(["ideal", "bond", "flaw", "goal", "cooperation"] as const).map(
              (field, index) => (
                <p key={field}>
                  {["理想", "羁绊", "缺点", "目标", "合作理由"][index]}：
                  {build.profile[field] || "尚未填写"}
                </p>
              ),
            )}
            <p className="subtle-note">
              种族特征中的抗性、魅惑豁免、完整隐藏与负重规则供扮演参考；当前自动裁定范围见手册。
            </p>
          </>
        )}
      </details>
    </>
  );
}
