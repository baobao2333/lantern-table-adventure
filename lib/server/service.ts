import { z } from "zod";
import { runtime } from "./runtime";
import { CAMPAIGNS, campaignForGame } from "@/lib/game/campaigns";
import { createHero } from "@/lib/game/characters";
import { addMessage, createGame, gameView, resolve } from "@/lib/game/engine";
import * as repository from "@/lib/server/repository";
import {
  campReply,
  interpret,
  interpretWorld,
  narrate,
} from "@/lib/server/narrator";
import { stageIdea } from "@/lib/game/world-engine";
import { buildHero } from "@/lib/game/character-builder";
import type { HeroBuildInput } from "@/lib/game/types";

const uuid = z.string().uuid(),
  shortText = z.string().trim().min(1).max(700);
const payload = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("hero.create"),
    classId: z.enum(["fighter", "rogue", "wizard"]),
    name: z.string().trim().min(1).max(24),
    background: z.string().trim().max(600).default(""),
  }),
  z.object({ op: z.literal("hero.build"), build: z.record(z.unknown()) }),
  z.object({
    op: z.literal("game.create"),
    heroId: uuid,
    campaignId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    mode: z.enum(["solo", "party"]),
  }),
  z.object({
    op: z.literal("game.command"),
    id: uuid,
    requestId: uuid,
    expectedVersion: z.number().int().min(0),
    command: z.object({
      kind: z.enum([
        "action",
        "roll",
        "attack",
        "missile",
        "dodge",
        "potion",
        "wind",
        "rest",
        "retreat",
        "start",
        "confirm",
        "cancel",
        "session",
        "spell",
      ]),
      actionId: z.string().max(100).optional(),
    }),
  }),
  z.object({
    op: z.literal("game.talk"),
    id: uuid,
    requestId: uuid,
    expectedVersion: z.number().int().min(0),
    text: shortText,
  }),
  z.object({ op: z.literal("camp.talk"), heroId: uuid, text: shortText }),
]);
function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function failure(error: unknown) {
  if (error instanceof repository.ApiError)
    return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError)
    return json({ error: "输入格式不正确，请检查名称或邀请码。" }, 400);
  // Never include database errors, request bodies or provider credentials in responses.
  return json(
    {
      error:
        error instanceof Error &&
        !/SQL|D1|database|fetch|JSON|constraint/i.test(error.message)
          ? error.message
          : "存档服务暂时无法完成操作，请稍后重试。",
    },
    400,
  );
}
export async function handleGET(request: Request, userId: string) {
  try {
    const url = new URL(request.url),
      id = url.searchParams.get("id"),
      heroId = url.searchParams.get("camp");
    if (id) {
      uuid.parse(id);
      const { game, version } = await repository.loadGame(id, userId);
      return json({ view: gameView(game, version) });
    }
    if (heroId) {
      uuid.parse(heroId);
      await repository.ownedHero(heroId, userId);
      return json({ messages: await repository.campLog(heroId, userId) });
    }
    const [heroes, games] = await Promise.all([
      repository.listHeroes(userId),
      repository.listGames(userId),
    ]);
    return json({
      userId,
      aiReady: runtime().aiReady,
      local: !!runtime().local,
      version: "0.3.0-beta.1",
      heroes,
      campaigns: CAMPAIGNS.map(
        ({
          id,
          title,
          subtitle,
          description,
          minutes,
          theme,
          difficulty,
          revision,
          scenes,
        }) => ({
          id,
          title,
          subtitle,
          description,
          minutes,
          theme,
          difficulty,
          revision,
          sceneCount: scenes.length,
        }),
      ),
      games: games.map(({ game, version }) => ({
        id: game.id,
        title: campaignForGame(game).title,
        status: game.status,
        mode: game.mode,
        scene: game.scene,
        version,
        heroNames: game.players.map((p) => p.hero.name),
        roomCode: game.roomCode,
        campaignFormat: game.world ? "situation-v1" : "scene-v1",
      })),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function handlePOST(request: Request, userId: string) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new repository.ApiError("请从本站发起操作。", 403);
    if (Number(request.headers.get("content-length")) > 16000)
      throw new repository.ApiError("输入太长。");
    const raw = await request.text();
    if (raw.length > 16000) throw new repository.ApiError("输入太长。");
    const body = payload.parse(JSON.parse(raw));
    if (body.op === "hero.create") {
      const hero = createHero(
        crypto.randomUUID(),
        body.classId,
        body.name,
        body.background,
      );
      await repository.saveHero(hero, userId);
      return json({ hero });
    }
    if (body.op === "hero.build") {
      const input = {
        ...body.build,
        id: crypto.randomUUID(),
      } as HeroBuildInput;
      const hero = buildHero(input);
      await repository.saveHero(hero, userId);
      return json({ hero });
    }
    if (body.op === "game.create") {
      if (body.mode !== "solo")
        throw new repository.ApiError(
          "多人请从桌面版的多人组队入口创建房间。",
        );
      const hero = await repository.ownedHero(body.heroId, userId),
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const game = createGame(
        crypto.randomUUID(),
        userId,
        hero,
        body.campaignId,
        body.mode,
        Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""),
      );
      await repository.insertGame(game);
      return json({ view: gameView(game, 0) });
    }
    if (body.op === "camp.talk") {
      const hero = await repository.ownedHero(body.heroId, userId),
        messages = await repository.campLog(hero.id, userId);
      const text = await campReply(hero, messages, body.text);
      messages.push(
        { id: crypto.randomUUID(), role: "player", text: body.text },
        {
          id: crypto.randomUUID(),
          role: "dm",
          actor: hero.name,
          text,
          ai: true,
        },
      );
      await repository.saveCampLog(hero.id, userId, messages);
      return json({ messages });
    }
    const id = body.id;
    await repository.loadGame(id, userId);
    const lease = await repository.acquire(id, body.requestId);
    try {
      if (lease.duplicate) {
        if (!lease.game.players.some((p) => p.userId === userId))
          throw new repository.ApiError("你不在这个房间中。", 403);
        return json({ view: gameView(lease.game, lease.version) });
      }
      if (body.expectedVersion !== lease.version)
        throw new repository.ApiError(
          "队伍存档已更新。请刷新当前冒险，再决定下一步行动。",
          409,
          "stale_version",
        );
      if (body.op === "game.talk") {
        if (lease.game.status !== "active")
          throw new repository.ApiError("请先开始冒险，再与主持人交流。");
        const hero = lease.game.players.find((p) => p.userId === userId)!.hero;
        if (lease.game.world) {
          const intent = await interpretWorld(lease.game, body.text, { actorId: userId }).catch(() => {
            throw new repository.ApiError("主持人暂时无法理解这次输入，尚未执行行动。可改用规则按钮或稍后重试。", 503, "intent_failed");
          });
          if (intent.kind === "proposal" && intent.idea)
            stageIdea(lease.game, hero, intent.idea);
          addMessage(lease.game, "player", body.text, hero.name);
          addMessage(
            lease.game,
            "dm",
            intent.response,
            undefined,
            undefined,
            true,
          );
          const version = await repository.commit(
            lease.game,
            lease.token,
            lease.version,
            body.requestId,
          );
          return json({ view: gameView(lease.game, version) });
        }
        const intent = await interpret(lease.game, body.text, { actorId: userId }).catch(() => {
          throw new repository.ApiError("主持人暂时无法理解这次输入，尚未执行行动。可改用规则按钮或稍后重试。", 503, "intent_failed");
        });
        addMessage(lease.game, "player", body.text, hero.name);
        addMessage(
          lease.game,
          "dm",
          intent.response,
          undefined,
          undefined,
          true,
        );
        const version = await repository.commit(
          lease.game,
          lease.token,
          lease.version,
          body.requestId,
        );
        return json({
          view: gameView(lease.game, version),
          proposal:
            intent.kind === "action" ? { actionId: intent.actionId } : null,
        });
      }
      const resolution = resolve(lease.game, userId, body.command);
      // Persist mechanics before asking the model. A timeout must never reroll or consume resources twice.
      let version = await repository.commit(
        resolution.state,
        lease.token,
        lease.version,
        body.requestId,
      );
      let aiNotice: string | null = null;
      if (
        runtime().aiReady &&
        resolution.state.status === "active" &&
        !resolution.state.pending &&
        !resolution.state.world?.proposal &&
        !["wind", "cancel"].includes(body.command.kind)
      ) {
        try {
          const text = await narrate(resolution.state, resolution.fact);
          addMessage(resolution.state, "dm", text, undefined, undefined, true);
          version = await repository.commit(
            resolution.state,
            lease.token,
            version,
            body.requestId,
          );
        } catch (error) {
          aiNotice =
            error instanceof Error
              ? error.message
              : "AI 叙事暂未生成；本次规则结果已保存。";
        }
      }
      return json({ view: gameView(resolution.state, version), aiNotice });
    } finally {
      await repository.unlock(id, lease.token);
    }
  } catch (error) {
    return failure(error);
  }
}
