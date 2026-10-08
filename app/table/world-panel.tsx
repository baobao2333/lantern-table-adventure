"use client";
import { Check, Compass, Hourglass, ScrollText, Users } from "lucide-react";
import type { View } from "@/lib/game/types";
import type { Command } from "@/lib/game/engine";
export function WorldPanel({
  view,
  busy,
  command,
}: {
  view: View;
  busy: boolean;
  command: (action: Command) => Promise<unknown>;
}) {
  const world = view.world;
  if (!world) return null;
  return (
    <>
      <section className="side-card world-map">
        <h3>
          <Compass size={16} />
          河谷行路
        </h3>
        <p className="subtle-note">
          亮起的地点可以直接前往；其他地点需要沿道路走。
        </p>
        <div className="map-locations">
          {world.locations.map((place) => (
            <button
              key={place.id}
              className={
                place.current ? "current" : place.adjacent ? "adjacent" : ""
              }
              disabled={
                busy ||
                !place.adjacent ||
                !!view.game.world?.proposal ||
                !!view.game.combat ||
                view.game.status !== "active"
              }
              onClick={() =>
                void command({ kind: "action", actionId: `travel:${place.id}` })
              }
            >
              {place.current ? "●" : "◇"} {place.title}
            </button>
          ))}
        </div>
      </section>
      <section className="side-card">
        <h3>
          <Users size={16} />
          这里的人
        </h3>
        {world.npcs.map((npc) => (
          <div className="npc-entry" key={npc.id}>
            <strong>
              {npc.name}
              <small>
                {npc.trust > 0
                  ? "愿意靠近"
                  : npc.trust < 0
                    ? "有所戒备"
                    : "正在观察"}
              </small>
            </strong>
            <p>{npc.role}</p>
            <p className="npc-want">在意：{npc.want}</p>
          </div>
        ))}
      </section>
      <section className="side-card">
        <h3>
          <Check size={16} />
          你留下的改变
        </h3>
        <div className="objective-list">
          {!world.objectives.length && (
            <p className="subtle-note">
              你做出的改变会记在这里；未知的故事等你亲自发现。
            </p>
          )}
          {world.objectives.map((goal) => (
            <details key={goal.id}>
              <summary className={goal.done ? "done" : ""}>
                <span>{goal.done ? "✓" : "○"}</span>
                {goal.title}
              </summary>
              <p>{goal.description}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="side-card">
        <h3>
          <Hourglass size={16} />
          世界仍在向前
        </h3>
        {world.clocks.map((clock) => (
          <div className="world-clock" key={clock.id}>
            <div>
              <span>{clock.title}</span>
              <small>
                {clock.stopped ? "已稳住" : `${clock.current}/${clock.max}`}
              </small>
            </div>
            <div className="clock-track">
              <i style={{ width: `${(clock.current / clock.max) * 100}%` }} />
            </div>
          </div>
        ))}
        <p className="subtle-note">
          行动与失败都会耗时。你也可以改变局势，让对应事件停止推进。
        </p>
      </section>
      {world.hooks.length > 0 && (
        <section className="side-card backstory-hook">
          <h3>和你的过去有关</h3>
          {world.hooks.map((hook) => (
            <p key={hook.id}>{hook.question}</p>
          ))}
          <small>这是人物话题，身份与传闻仍需在故事中证实。</small>
        </section>
      )}
      <section className="side-card">
        <h3>
          <ScrollText size={16} />
          旅途手记
        </h3>
        <details className="world-journal">
          <summary>翻看最近的重要决定</summary>
          {view.game.world?.journal
            .slice(-24)
            .reverse()
            .map((event) => (
              <p key={event.id}>
                <small>
                  行动 {event.turn} ·{" "}
                  {event.kind === "claim"
                    ? "人物声明"
                    : event.kind === "decision"
                      ? "你的选择"
                      : "世界事件"}
                </small>
                {event.text}
              </p>
            ))}
        </details>
      </section>
    </>
  );
}
