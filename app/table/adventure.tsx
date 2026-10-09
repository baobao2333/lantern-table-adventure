"use client";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Dice5,
  Heart,
  Hourglass,
  LoaderCircle,
  Moon,
  ScrollText,
  Send,
  Shield,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import {
  ABILITIES,
  abilityMod,
  CLASSES,
  skillMod,
  SKILLS,
} from "@/lib/game/characters";
import { SPELLS, spellAvailability } from "@/lib/game/spells";
import {
  CANTRIP_OPTIONS,
  FIRST_LEVEL_SPELL_OPTIONS,
} from "@/lib/game/character-builder";
import type {
  Ability,
  CantripId,
  FirstLevelSpellId,
  Hero,
  View,
} from "@/lib/game/types";
import type { Command } from "@/lib/game/engine";
import { Avatar, classIcon, sign, Transcript } from "./components";
import type { Bootstrap } from "./client";
import { WorldPanel } from "./world-panel";
import { CharacterDetails } from "./character-details";

type Props = {
  view: View;
  data: Bootstrap;
  busy: boolean;
  command: (action: Command) => Promise<unknown>;
  navigate: () => void;
  help: () => void;
  text: string;
  setText: (text: string) => void;
  talk: () => Promise<unknown>;
  legacyProposal: string | null;
  dismissProposal: () => void;
};
function Spells({
  hero,
  combat,
  busy,
  command,
}: {
  hero: Hero;
  combat: boolean;
  busy: boolean;
  command: Props["command"];
}) {
  const build = hero.build;
  const cantrips: CantripId[] = build
    ? [
        ...new Set([
          ...build.cantrips,
          ...(build.racialCantrip ? [build.racialCantrip] : []),
        ]),
      ]
    : hero.classId === "wizard"
      ? ["fire-bolt"]
      : [];
  const prepared: FirstLevelSpellId[] = build
    ? build.preparedSpells
    : hero.classId === "wizard"
      ? ["magic-missile"]
      : [];
  const rituals = (build?.spellbook || []).filter(
    (id) => FIRST_LEVEL_SPELL_OPTIONS[id].ritual,
  );
  const choices = [
    ...cantrips.map((id) => ({ id, ...CANTRIP_OPTIONS[id], cost: 0 })),
    ...prepared.map((id) => ({
      id,
      ...FIRST_LEVEL_SPELL_OPTIONS[id],
      cost: 1,
    })),
  ].filter((spell) =>
    combat
      ? spell.capability === "combat" && spell.id !== "mage-armor"
      : spell.capability === "exploration" || spell.id === "mage-armor",
  );
  if (!choices.length && (!rituals.length || combat)) return null;
  return (
    <div className="spell-actions">
      <h4>{combat ? "施放战斗法术" : "你的法术"}</h4>
      {choices.map((spell) => (
        <button
          className="spell-choice"
          title={spell.description}
          key={spell.id}
          disabled={
            busy ||
            !spellAvailability(hero, spell.id, { inCombat: combat }).allowed
          }
          onClick={() => void command({ kind: "spell", actionId: spell.id })}
        >
          <span>
            <Sparkles size={14} />
            {spell.name}
            <small>{spell.description}</small>
          </span>
          <b>{spell.cost ? "1 法术位" : "戏法"}</b>
        </button>
      ))}
      {!combat &&
        rituals.map((id) => (
          <button
            className="spell-choice"
            key={`ritual:${id}`}
            disabled={busy}
            onClick={() =>
              void command({ kind: "spell", actionId: `ritual:${id}` })
            }
          >
            <span>
              {FIRST_LEVEL_SPELL_OPTIONS[id].name} · 仪式
              <small>额外施法 10 分钟；不消耗法术位，局势继续推进。</small>
            </span>
            <b>仪式</b>
          </button>
        ))}
    </div>
  );
}
export function Adventure({
  view,
  data,
  busy,
  command,
  navigate,
  help,
  text,
  setText,
  talk,
  legacyProposal,
  dismissProposal,
}: Props) {
  const game = view.game,
    hero = game.players.find((p) => p.userId === data.userId)?.hero;
  const pending = game.world?.proposal,
    currentTurn = game.combat?.order[game.combat.turn];
  const myTurn = !game.combat || currentTurn === hero?.id,
    blocked = busy || !!game.pending || !!pending || hero?.hp === 0;
  const preparation =
    pending?.goalId &&
    game.world?.preparations.includes(`${pending.location}:${pending.skill}`);
  const stealthDisadvantage =
    pending?.skill === "stealth" && hero?.build?.armorStealthDisadvantage;
  const method =
    preparation && !stealthDisadvantage
      ? "优势 · 取高"
      : stealthDisadvantage && !preparation
        ? "劣势 · 取低"
        : "1d20";
  return (
    <main className="adventure-page">
      <div className="adventure-heading">
        <button
          className="icon-button"
          aria-label="返回大厅"
          onClick={navigate}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <span className="eyebrow">
            {game.mode === "party" ? "PARTY ADVENTURE" : "SOLO ADVENTURE"} ·{" "}
            {view.world
              ? `第 ${view.world.session} 次游玩 · 自由探索`
              : `第 ${game.scene + 1} / ${view.sceneCount} 幕`}
          </span>
          <h1>{view.title}</h1>
        </div>
        {!view.world && (
          <div
            className="danger-meter"
            title="失败与延误增加危险，达到 4 影响结局"
          >
            <span>
              <Hourglass size={14} />
              危险 {game.danger}/6
            </span>
            <div>
              {Array.from({ length: 6 }, (_, i) => (
                <i className={i < game.danger ? "filled" : ""} key={i} />
              ))}
            </div>
          </div>
        )}
        <button className="text-button desktop-only" onClick={help}>
          <BookOpen size={16} />
          规则
        </button>
      </div>
      <div className="adventure-layout">
        <section className="adventure-main">
          <div className="scene-card">
            <div className="scene-number">0{game.scene + 1}</div>
            <div>
              <span className="eyebrow">
                {view.world ? "CURRENT LOCATION" : "CURRENT SCENE"}
              </span>
              <h2>{view.scene.title}</h2>
              <p>{view.scene.description}</p>
            </div>
          </div>
          {game.status === "waiting" && (
            <div className="waiting-card">
              <h2>旅人们正在准备</h2>
              <p>所有旅人准备就绪后，由房主开始冒险。</p>
              <button className="button primary" onClick={navigate}>
                返回大厅
              </button>
            </div>
          )}
          {game.status === "complete" && view.ending && (
            <div className="ending-card">
              <span className="ending-mark">✦</span>
              <span className="eyebrow">A STORY TO REMEMBER</span>
              <h2>{view.ending.title}</h2>
              <p>{view.ending.text}</p>
              <div className="ending-details">
                <span>{game.turns} 次行动</span>
                <span>{view.clues.length} 条线索</span>
              </div>
              <button className="button primary" onClick={navigate}>
                带着故事回到大厅 <ArrowRight size={16} />
              </button>
            </div>
          )}
          <div className="journal-heading">
            <span>
              <ScrollText size={17} />
              冒险记录
            </span>
            <span>{data.local ? "已自动保存至本机" : "已自动保存至云端"}</span>
          </div>
          <Transcript messages={game.messages} />
          {game.status === "active" && (
            <>
              <div className="action-area">
                {pending ? (
                  <div className="pending-card world-proposal">
                    <div className="pending-header">
                      <span className="die-face">
                        <Dice5 size={36} />
                      </span>
                      <div>
                        <span className="eyebrow">YOUR IDEA, CLEAR STAKES</span>
                        <h3>{pending.title}</h3>
                        <p>{pending.approach}</p>
                      </div>
                    </div>
                    {pending.kind === "check" ? (
                      <div className="check-values">
                        <span>
                          <small>难度 DC</small>
                          <strong>{pending.dc}</strong>
                        </span>
                        <span>
                          <small>{SKILLS[pending.skill].name}加值</small>
                          <strong>{sign(pending.modifier)}</strong>
                        </span>
                        <span>
                          <small>掷骰方式</small>
                          <strong>{method}</strong>
                        </span>
                      </div>
                    ) : (
                      <p className="scope-note">确定可行的行动，无需掷骰。</p>
                    )}
                    <p className="stakes">
                      <strong>成功：</strong>
                      {pending.success}
                    </p>
                    {pending.kind === "check" && (
                      <p className="stakes">
                        <strong>失败：</strong>
                        {pending.failure}
                      </p>
                    )}
                    {pending.spellId && (
                      <p className="subtle-note">
                        确认后才施放
                        {SPELLS[pending.spellId as keyof typeof SPELLS].name}
                        ，消耗{" "}
                        {SPELLS[pending.spellId as keyof typeof SPELLS].level}{" "}
                        个一环法术位。法术不会保证检定成功。
                      </p>
                    )}
                    <p className="subtle-note">
                      行动耗时 {pending.timeCost}{" "}
                      格。失败可能额外耗时；世界事件会继续推进。
                    </p>
                    <div className="proposal-controls">
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void command({ kind: "confirm" })}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={18} />
                        ) : (
                          <Dice5 size={18} />
                        )}
                        确认{pending.kind === "check" ? "代价并掷骰" : "并行动"}
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void command({ kind: "cancel" })}
                      >
                        放弃，换个办法
                      </button>
                    </div>
                  </div>
                ) : game.pending ? (
                  <div className="pending-card">
                    <div className="pending-header">
                      <span className="die-face">
                        <Dice5 size={36} />
                      </span>
                      <div>
                        <span className="eyebrow">THE DICE HAVE A SAY</span>
                        <h3>{game.pending.title}</h3>
                        <p>{SKILLS[game.pending.skill].name}检定</p>
                      </div>
                    </div>
                    <div className="check-values">
                      <span>
                        <small>难度 DC</small>
                        <strong>{game.pending.dc}</strong>
                      </span>
                      <span>
                        <small>你的加值</small>
                        <strong>{sign(game.pending.modifier)}</strong>
                      </span>
                      <span>
                        <small>掷骰方式</small>
                        <strong>
                          {game.pending.advantage && !game.pending.disadvantage
                            ? "优势 · 取高"
                            : game.pending.disadvantage &&
                                !game.pending.advantage
                              ? "劣势 · 取低"
                              : "1d20"}
                        </strong>
                      </span>
                    </div>
                    <p className="stakes">
                      <strong>失败代价：</strong>
                      {game.pending.consequence}危险刻度 +1。
                    </p>
                    <button
                      className="button primary roll-button"
                      disabled={busy || game.pending.actorId !== hero?.id}
                      onClick={() => void command({ kind: "roll" })}
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <Dice5 size={19} />
                      )}
                      确认代价，掷出骰子
                    </button>
                  </div>
                ) : game.combat ? (
                  <div className="combat-card">
                    <div className="combat-heading">
                      <Swords size={21} />
                      <strong>第 {game.combat.round} 回合</strong>
                      <span>
                        轮到{" "}
                        {game.players.find((p) => p.hero.id === currentTurn)
                          ?.hero.name || "对手"}
                      </span>
                    </div>
                    <div className="enemy-row">
                      <span className="enemy-symbol">☾</span>
                      <div>
                        <strong>{game.combat.enemy.name}</strong>
                        <div className="hp-track">
                          <i
                            style={{
                              width: `${(game.combat.enemy.hp / game.combat.enemy.maxHp) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                      <span>
                        {game.combat.enemy.hp}/{game.combat.enemy.maxHp} HP
                        <small>AC {game.combat.enemy.ac}</small>
                      </span>
                    </div>
                    <div className="combat-actions">
                      <button
                        className="button primary"
                        disabled={busy || !myTurn}
                        onClick={() => void command({ kind: "attack" })}
                      >
                        {hero && classIcon(hero.classId, 17)}
                        {hero?.build?.weapon.name ||
                          (hero ? CLASSES[hero.classId].weapon : "攻击")}
                        攻击
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy || !myTurn}
                        onClick={() => void command({ kind: "dodge" })}
                      >
                        <Shield size={16} />
                        闪避一回合
                      </button>
                    </div>
                    {hero && (
                      <Spells
                        hero={hero}
                        combat
                        busy={busy || !myTurn}
                        command={command}
                      />
                    )}
                    <p className="subtle-note">
                      抽象站位、单一对手。每回合一个主要动作，骰子与伤害由规则结算。
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="action-heading">
                      <span>你打算怎么做？</span>
                      <small>选择行动，或自由表达</small>
                    </div>
                    <div className="action-grid">
                      {view.actions.map((action) => (
                        <button
                          className={`action-option ${action.kind === "combat" ? "risky" : ""}`}
                          key={action.id}
                          disabled={busy}
                          onClick={() =>
                            void command({
                              kind: "action",
                              actionId: action.id,
                            })
                          }
                        >
                          <div className="action-option-top">
                            <strong>{action.title}</strong>
                            {action.kind === "combat" ? (
                              <Swords size={16} />
                            ) : action.skill ? (
                              <Dice5 size={16} />
                            ) : (
                              <ArrowRight size={16} />
                            )}
                          </div>
                          <p>{action.description}</p>
                          <span>
                            {action.kind === "combat"
                              ? "战斗 · 先攻决定顺序"
                              : action.skill
                                ? `${SKILLS[action.skill].name} · DC ${action.dc}`
                                : "确定可行 · 无需掷骰"}
                          </span>
                        </button>
                      ))}
                    </div>
                    {view.world && (
                      <p className="subtle-note">
                        这些是当前可见的机会。也可以直接描述新的办法；先说明规则，确认后才会发生。
                      </p>
                    )}
                  </>
                )}
              </div>
              {legacyProposal && (
                <div className="proposal-card">
                  <Sparkles size={17} />
                  <div>
                    <strong>主持人的行动建议</strong>
                    <p>
                      {view.actions.find((a) => a.id === legacyProposal)
                        ?.title || "建议已不适用于当前场景"}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={
                      busy || !view.actions.some((a) => a.id === legacyProposal)
                    }
                    onClick={() =>
                      void command({ kind: "action", actionId: legacyProposal })
                    }
                  >
                    采用建议
                  </button>
                  <button
                    className="icon-button"
                    aria-label="取消建议"
                    onClick={dismissProposal}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void talk();
                }}
              >
                <input
                  aria-label="对主持人说"
                  placeholder={
                    data.aiReady
                      ? "“我想先问问他…” 说明你的目的和方法"
                      : "连接 AI 后，可以自由对话和行动"
                  }
                  value={text}
                  maxLength={700}
                  disabled={busy || !data.aiReady}
                  onChange={(e) => setText(e.target.value)}
                />
                <button
                  className="send-button"
                  aria-label="发送给主持人"
                  disabled={busy || !data.aiReady || !text.trim()}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Send size={18} />
                  )}
                </button>
              </form>
              <p className="composer-note">
                {busy
                  ? "主持人正在回应，规则结果会先保存。"
                  : "可以提问、扮演，也可以提出新办法。行动需要你确认。"}
              </p>
            </>
          )}
        </section>
        <aside className="adventure-side">
          {hero && (
            <section className="hero-sheet">
              <div className="sheet-heading">
                <Avatar hero={hero} small />
                <div>
                  <h3>{hero.name}</h3>
                  <p>
                    一级 · {hero.species} · {CLASSES[hero.classId].name}
                  </p>
                </div>
                <Shield size={17} />
                <span>{hero.ac}</span>
              </div>
              <div className="hp-heading">
                <span>
                  <Heart size={14} />
                  生命
                </span>
                <strong>
                  {hero.hp} <small>/ {hero.maxHp}</small>
                </strong>
              </div>
              <div className="hp-track">
                <i style={{ width: `${(hero.hp / hero.maxHp) * 100}%` }} />
              </div>
              <div className="ability-grid">
                {Object.entries(hero.abilities).map(([key, value]) => (
                  <div key={key}>
                    <small>{ABILITIES[key as Ability]}</small>
                    <strong>{sign(abilityMod(value))}</strong>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
              <h4>熟练技能</h4>
              <div className="skill-list">
                {hero.skills.map((skill) => (
                  <span key={skill}>
                    {SKILLS[skill].name}
                    {hero.build?.expertise.includes(skill) ? "＊" : ""}
                    <strong>{sign(skillMod(hero, skill))}</strong>
                  </span>
                ))}
              </div>
              <div className="resource-list">
                <span>
                  治疗药水<strong>{hero.potions} 瓶</strong>
                </span>
                <span>
                  生命骰<strong>{hero.hitDice} 枚</strong>
                </span>
                {hero.classId === "fighter" && (
                  <span>
                    复苏之风<strong>{hero.secondWind} 次</strong>
                  </span>
                )}
                {hero.classId === "wizard" && (
                  <span>
                    一环法术位<strong>{hero.spellSlots} / 2</strong>
                  </span>
                )}
              </div>
              {game.status === "active" && (
                <>
                  <div className="resource-actions">
                    <button
                      disabled={
                        blocked ||
                        !myTurn ||
                        !hero.potions ||
                        hero.hp === hero.maxHp
                      }
                      onClick={() => void command({ kind: "potion" })}
                    >
                      饮用治疗药水 <Heart size={14} />
                    </button>
                    {game.mode === "party" && game.players.filter(player => player.hero.id !== hero.id && player.hero.hp === 0).map(player => (
                      <button key={player.hero.id} disabled={blocked || !myTurn || !hero.potions}
                        onClick={() => void command({ kind: "potion", targetHeroId: player.hero.id })}>
                        用自己的药水救起 {player.hero.name} · 主要动作 <Heart size={14} />
                      </button>
                    ))}
                    {hero.classId === "fighter" && (
                      <button
                        disabled={
                          blocked ||
                          !myTurn ||
                          !hero.secondWind ||
                          hero.hp === hero.maxHp
                        }
                        onClick={() => void command({ kind: "wind" })}
                      >
                        复苏之风 · 附赠动作 <Sparkles size={14} />
                      </button>
                    )}
                    <button
                      disabled={
                        blocked ||
                        !!game.combat ||
                        !view.scene.safeRest ||
                        (game.lastRestScene === game.scene &&
                          (!game.world ||
                            game.lastRestChapter === game.world.session))
                      }
                      onClick={() => void command({ kind: "rest" })}
                    >
                      安全短休 · 1 小时 <Moon size={14} />
                    </button>
                    {view.world && (
                      <button
                        disabled={
                          blocked ||
                          !!game.combat ||
                          !view.scene.safeRest ||
                          game.turns - (game.world?.restAt || 0) < 12
                        }
                        onClick={() => void command({ kind: "session" })}
                      >
                        章节休整 · 时间 +8 <Moon size={14} />
                      </button>
                    )}
                    <button
                      className="retreat-button"
                      disabled={busy}
                      onClick={() => void command({ kind: "retreat" })}
                    >
                      结束并返回安全地带
                    </button>
                  </div>
                  {!game.combat && (
                    <Spells
                      hero={hero}
                      combat={false}
                      busy={blocked}
                      command={command}
                    />
                  )}
                </>
              )}
              <CharacterDetails hero={hero} />
              {!!hero.activeSpellEffects?.length && (
                <div className="scope-note">
                  <Sparkles size={16} />
                  <p>
                    {hero.activeSpellEffects
                      .map(
                        (effect) =>
                          `${SPELLS[effect.spellId].name}：剩余约 ${Math.max(0, Math.ceil(effect.expiresAt - (game.elapsedMinutes || 0)))} 分钟${effect.concentration ? "（专注）" : ""}`,
                      )
                      .join("；")}
                  </p>
                </div>
              )}
            </section>
          )}
          {view.clues.length > 0 && (
            <section className="side-card">
              <h3>
                <ScrollText size={16} />
                已知的线索
              </h3>
              {view.clues.map((clue) => (
                <div className="clue" key={clue.title}>
                  <strong>{clue.title}</strong>
                  <p>{clue.text}</p>
                </div>
              ))}
            </section>
          )}
          <WorldPanel view={view} busy={busy} command={command} />
          <div className="table-reminder">
            <Sparkles size={17} />
            <p>
              你可以做大胆的选择。
              <br />
              人物的反应，会为故事留下下一步。
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
