"use client";
import { useEffect, useRef } from "react";
import {
  BookOpen,
  Dice5,
  Flame,
  KeyRound,
  MessageCircle,
  ScrollText,
  Swords,
  WandSparkles,
} from "lucide-react";
import type { Hero, HeroClass, Message } from "@/lib/game/types";

export const classIcon = (id: HeroClass, size = 24) =>
  id === "fighter" ? (
    <Swords size={size} />
  ) : id === "rogue" ? (
    <KeyRound size={size} />
  ) : (
    <WandSparkles size={size} />
  );
export const sign = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
export function Avatar({
  hero,
  small = false,
}: {
  hero: Hero;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${hero.classId} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {classIcon(hero.classId, small ? 20 : 36)}
      <span className="avatar-star">✦</span>
    </span>
  );
}
export function RuleContent() {
  return (
    <div className="rule-copy">
      <p className="eyebrow">THE FIRST STEP</p>
      <h2>
        先说你想做什么。
        <br />
        剩下的，我们一起学。
      </h2>
      <p>
        跑团像一起创作故事：主持人描述世界，你决定角色怎么行动。当结果不确定，而且失败会有代价时，才交给骰子。
      </p>
      <div className="rule-example">
        <Dice5 />
        <div>
          <strong>d20 + 你的加值 ≥ 难度 DC</strong>
          <span>例如调查加值 +3、难度 12：掷出 9，总值 12，成功。</span>
        </div>
      </div>
      <h3>这里的骰子是透明的</h3>
      <p>
        每次检定先显示难度、加值、优势与失败后果，再由服务器掷骰。优势掷两颗 d20
        取高值，劣势取低值；两者抵消。穿戴造成的潜行劣势与半身人幸运会真实结算。闪避让敌人的攻击有劣势。技能检定的自然
        1 或 20 不会自动失败或成功。
      </p>
      <h3>战斗不是唯一解法</h3>
      <p>
        先攻决定顺序，每回合一个主要动作。攻击总值达到护甲等级 AC 即命中；自然 1
        必失，自然 20
        必中，伤害骰翻倍，加值不翻倍。闪避和喝药占用动作；战士的复苏之风是附赠动作，使用后仍可攻击。
      </p>
      <h3>你的资源真的会消耗</h3>
      <p>
        治疗药水恢复 2d4 + 2 生命。法师有两个一环法术位，魔法飞弹自动命中，造成
        3d4 + 3
        伤害；火焰箭是可重复施放的戏法。其他已支持法术按角色卡、准备列表、持续时间与专注结算。睡眠术根据当前生命决定是否暂时结束冲突，并不造成伤害。当前采用抽象站位与单一对手；单人游荡者不会无条件偷袭。新建角色不赠送治疗药水。
      </p>
      <h3>休息与新手救援房规</h3>
      <p>
        安全地点可短休一小时，每处每章节最多一次。持续战役时钟推进 6
        格，教学短篇危险刻度
        +2。一级角色有一枚生命骰；战士复苏之风恢复，法师每章节可用一次奥术回想恢复一个一环法术位。持续战役还能安全休整八小时：恢复生命与职业资源，时钟推进
        8 格，两次章节休整需间隔至少 12
        次行动。休息不补发药水。新手模式中，任何队员生命降至
        0，单人冒险会获救并结束本次冒险；多人冒险中角色倒地，不能行动或维持专注，敌人会忽略倒地角色。同伴可用自己的药水和主要动作救援；全队倒地才触发救援并结束。这里明确替代标准规则的死亡豁免。
      </p>
      <h3>一次失败，故事仍在继续</h3>
      <p>
        持续战役的多个时钟各自记录世界变化；救援、调查或交涉可以稳定局势。达到阈值会触发事件和明确的新进展，结局由你主动选择。失败的相同方法不能原地重掷；换办法或取得相关准备可重试。教学短篇另用危险刻度（最多
        6），达到 4 会留下额外代价。
      </p>
      <h3>AI 在做什么？</h3>
      <p>
        AI
        理解自由输入、扮演人物、补充叙事。具体行动会先给建议，等你确认。生命、线索、骰子、资源与结局由规则引擎决定；AI
        无法修改。模型暂时无响应时，规则按钮与已保存的结果仍然有效。
      </p>
      <div className="scope-note">
        <BookOpen size={18} />
        <p>
          采用 SRD
          5.1（2014）一级角色教学子集，含原创冒险与明确房规。当前提供四种族、三职业、18
          项技能、六种戏法与七种一环法术，限一级。未实现完整职业、移动格、反应、升级与完整标准长休流程。性格和身世用于扮演；背景模板的熟练按角色表明确计算，自称神明或贵族不会凭空获得力量。
        </p>
      </div>
      <p className="attribution">
        This work includes material taken from the System Reference Document 5.1
        (“SRD 5.1”) by Wizards of the Coast LLC and available at{" "}
        <a
          href="https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf"
          target="_blank"
          rel="noreferrer"
        >
          SRD 5.1
        </a>
        . The SRD 5.1 is licensed under the{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/legalcode"
          target="_blank"
          rel="noreferrer"
        >
          Creative Commons Attribution 4.0 International License
        </a>
        . Rules translated and adapted; adventures are original. Independent
        project.
      </p>
    </div>
  );
}
export function Transcript({ messages }: { messages: Message[] }) {
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages.length]);
  return (
    <div className="transcript" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          <span className="message-mark">
            {message.role === "dm" ? (
              <Flame size={16} />
            ) : message.role === "player" ? (
              <MessageCircle size={15} />
            ) : (
              <ScrollText size={14} />
            )}
          </span>
          <div className="message-body">
            <div className="message-who">
              {message.role === "dm"
                ? message.actor || "主持人"
                : message.role === "player"
                  ? message.actor || "你"
                  : "规则记录"}
              {message.ai && <span className="ai-mark">AI</span>}
            </div>
            <p>{message.text}</p>
            {message.roll && (
              <div
                className={`roll-record ${message.roll.success ? "success" : "failure"}`}
              >
                <div className="roll-title">
                  <Dice5 size={17} />
                  <strong>{message.roll.label}</strong>
                  <span>
                    {message.roll.kind === "initiative"
                      ? "先攻"
                      : message.roll.kind === "healing"
                        ? "治疗"
                        : message.roll.kind === "damage"
                          ? "伤害"
                          : message.roll.success
                            ? "成功"
                            : "未成功"}
                  </span>
                </div>
                <div className="roll-equation">
                  <span className="rolled-dice">
                    {message.roll.rolls.join(" · ")}
                  </span>
                  <span>
                    {message.roll.rolls.length > 1 &&
                    ["check", "attack"].includes(message.roll.kind)
                      ? `取 ${message.roll.kept}`
                      : ""}{" "}
                    {sign(message.roll.modifier)}
                  </span>
                  <strong>= {message.roll.total}</strong>
                  {message.roll.target > 0 && (
                    <span>
                      / {message.roll.kind === "attack" ? "AC" : "DC"}{" "}
                      {message.roll.target}
                    </span>
                  )}
                </div>
                <small>{message.roll.explanation}</small>
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={tail} />
    </div>
  );
}
