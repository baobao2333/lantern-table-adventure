"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Dice5,
  Flame,
  HelpCircle,
  Hourglass,
  LoaderCircle,
  MessageCircle,
  Moon,
  Plus,
  ScrollText,
  Send,
  Tent,
  Users,
  X,
  Settings2,
} from "lucide-react";
import { CLASSES } from "@/lib/game/characters";
import type { HeroBuildInput, Message, View } from "@/lib/game/types";
import type { Command } from "@/lib/game/engine";
import { Avatar, RuleContent, Transcript } from "./components";
import { api, definitivelyRejected, type Bootstrap, type ToolContext, registerTools } from "./client";
import { pendingRequest, loadPendingRequest, savePendingRequest, clearPendingRequest, type PendingRequest } from "./request-journal";
import {
  buildHero,
  createDefaultHeroInput,
} from "@/lib/game/character-builder";
import { CharacterBuilder } from "./character-builder";
import { CharacterDetails } from "./character-details";
import { Adventure } from "./adventure";
import { Settings } from "./settings";
import { Multiplayer } from "./multiplayer";
import "../table.css";
import "./extended.css";

type Section = "lobby" | "characters" | "camp" | "rules" | "adventure" | "multiplayer";
export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [section, setSection] = useState<Section>("lobby");
  const [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [text, setText] = useState("");
  const [modal, setModal] = useState<"adventure" | "hero" | null>(null),
    [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false);
  const [campaignId, setCampaignId] = useState("moonbridge-conspiracy"),
    [heroId, setHeroId] = useState("");
  const [build, setBuild] = useState<HeroBuildInput>(() =>
    createDefaultHeroInput("fighter", "preview", "星桥"),
  );
  const [campHeroId, setCampHeroId] = useState(""),
    [campMessages, setCampMessages] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<string | null>(null);
  const operating = useRef(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const refresh = useCallback(async () => {
    const result = await api<Bootstrap>();
    setData(result);
    return result;
  }, []);
  useEffect(() => {
    api<Bootstrap>()
      .then(async (result) => {
        setPending(await loadPendingRequest(result.local));
        setData(result);
        setCampHeroId(result.heroes[0]?.id || "");
        const id = new URLSearchParams(location.search).get("adventure");
        if (id && result.games.some((g) => g.id === id)) {
          const r = await api<{ view: View }>(undefined, `?id=${id}`);
          setView(r.view);
          setSection("adventure");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!campHeroId) return;
    let active = true;
    api<{ messages: Message[] }>(undefined, `?camp=${campHeroId}`)
      .then((r) => {
        if (active) setCampMessages(r.messages);
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [campHeroId]);
  const activeGameId = view?.game.id;
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [section, activeGameId]);
  const run = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      if (operating.current) return;
      operating.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        return await task();
      } catch (e) {
        setError(e instanceof Error ? e.message : "暂时无法完成操作。");
      } finally {
        operating.current = false;
        setBusy(false);
      }
    },
    [],
  );
  const enter = useCallback(async (id: string) => {
    const r = await api<{ view: View }>(undefined, `?id=${id}`);
    setView(r.view);
    setSection("adventure");
    setProposal(null);
    setText("");
    history.replaceState(null, "", `?adventure=${id}`);
    return { id, status: r.view.game.status };
  }, []);
  const recoverRejected = useCallback(async (error: unknown, request: PendingRequest) => {
    if (!definitivelyRejected(error)) return;
    await clearPendingRequest(request.requestId);
    setPending(null);
    const result = await api<{ view: View }>(undefined, `?id=${encodeURIComponent(request.id)}`).catch(() => null);
    if (result) { setView(result.view); setProposal(null); }
  }, []);
  const command = useCallback(
    async (action: Command) => {
      if (!view) throw new Error("请先进入冒险。");
      return run(async () => {
        if (pendingRequest()) throw new Error("上次提交尚未确认，请先点击恢复上次行动。");
        const requestId = crypto.randomUUID();
        const payload = {
          op: "game.command",
          id: view.game.id,
          expectedVersion: view.version,
          command: action,
          requestId,
        };
        await savePendingRequest(payload);
        setPending(payload);
        let r: { view: View; aiNotice?: string };
        try { r = await api(payload); }
        catch (error) {
          await recoverRejected(error, payload);
          throw error;
        }
        await clearPendingRequest(requestId);
        setPending(null);
        setView(r.view);
        setProposal(null);
        if (r.aiNotice)
          setNotice("规则结果已保存。AI 叙事暂未生成，你可以继续行动。");
        return {
          id: r.view.game.id,
          status: r.view.game.status,
          version: r.view.version,
        };
      });
    },
    [view, run, recoverRejected],
  );
  const toolContext = useRef<ToolContext | null>(null);
  useEffect(() => {
    toolContext.current = { view, data, enter, command };
  }, [view, data, enter, command]);
  useEffect(() => registerTools(() => toolContext.current!), []);
  function create(
    selectedCampaign = "moonbridge-conspiracy",
    characterOnly = false,
  ) {
    setCampaignId(selectedCampaign);
    setHeroId(characterOnly ? "" : data?.heroes[0]?.id || "");
    setModal(characterOnly ? "hero" : "adventure");
    setBuild(createDefaultHeroInput("fighter", "preview", "星桥"));
    setError("");
  }
  async function saveCreation() {
    await run(async () => {
      let selected = heroId;
      if (!selected || modal === "hero") {
        const r = await api<{ hero: { id: string } }>({
          op: "hero.build",
          build,
        });
        selected = r.hero.id;
        setHeroId(selected);
      }
      if (modal === "hero") {
        setCampHeroId(selected);
        setModal(null);
        await refresh();
        setSection("characters");
        return;
      }
      const r = await api<{ view: View }>({
        op: "game.create",
        heroId: selected,
        campaignId,
        mode: "solo",
      });
      setView(r.view);
      setModal(null);
      setSection("adventure");
      setText("");
      setProposal(null);
      history.replaceState(null, "", `?adventure=${r.view.game.id}`);
      await refresh();
    });
  }
  async function talk(camp = false) {
    const input = text.trim();
    if (!input) return;
    await run(async () => {
      if (camp) {
        const r = await api<{ messages: Message[] }>({
          op: "camp.talk",
          heroId: campHeroId,
          text: input,
        });
        setCampMessages(r.messages);
      } else if (view) {
        if (pendingRequest()) throw new Error("上次提交尚未确认，请先恢复上次行动。");
        const payload = {
          op: "game.talk",
          id: view.game.id,
          expectedVersion: view.version,
          requestId: crypto.randomUUID(),
          text: input,
        };
        await savePendingRequest(payload); setPending(payload);
        let r: { view: View; proposal?: { actionId: string } };
        try { r = await api(payload); }
        catch (error) {
          await recoverRejected(error, payload);
          throw error;
        }
        await clearPendingRequest(payload.requestId); setPending(null);
        setView(r.view);
        setProposal(r.proposal?.actionId || null);
      }
      setText("");
    });
  }
  async function navigate(next: Section) {
    if (data?.local && section === "multiplayer" && next !== "multiplayer") {
      const exited = await run(async () => {
        const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "exit-session" }) });
        if (!response.ok) throw new Error("无法暂停或离开当前房间，请稍后重试。");
        return true;
      });
      if (!exited) return;
    }
    setSection(next);
    setError("");
    setText("");
    if (next === "lobby") {
      history.replaceState(null, "", "/");
      void refresh().catch((e) => setError(e.message));
    }
  }
  const campHero = data?.heroes.find((h) => h.id === campHeroId);
  let validBuild = true;
  try {
    buildHero(build);
  } catch {
    validBuild = false;
  }
  return (
    <div className="table-app">
      <aside className="sidebar">
        <Link
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("lobby");
          }}
        >
          <span className="brand-emblem">
            <Flame size={26} />
          </span>
          <span>
            灯火之下<small>LANTERN TABLE</small>
          </span>
        </Link>
        <div className="sidebar-label">你的冒险桌</div>
        <nav aria-label="主导航">
          {(
            [
              { id: "lobby", name: "模组大厅", icon: Compass },
              { id: "characters", name: "我的角色", icon: Users },
              { id: "camp", name: "营地夜话", icon: Tent },
              { id: "rules", name: "新手手册", icon: BookOpen },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>{item.name}</span>
              {section === item.id && <span className="nav-dot" />}
            </button>
          ))}
          {data?.local && <button className={`nav-item ${section === "multiplayer" ? "active" : ""}`} onClick={() => navigate("multiplayer")}><Users size={19} /><span>多人组队</span>{section === "multiplayer" && <span className="nav-dot" />}</button>}
          {view && (
            <button
              className={`nav-item ${section === "adventure" ? "active" : ""}`}
              onClick={() => navigate("adventure")}
            >
              <Dice5 size={19} />
              <span>当前冒险</span>
              <span className="live-dot" />
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="lantern-note">
            <Flame size={21} />
            <p>
              不必知道所有规则。
              <br />
              带上好奇心就够了。
            </p>
          </div>
          <div className="account">
            <span className="account-orb">旅</span>
            <div>
              <strong>旅人</strong>
              <small>
                v{data?.version || "0.3.0-beta.1"} ·{" "}
                {data?.local ? "本机冒险桌" : "私人冒险桌"}
              </small>
            </div>
            <Moon size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        {pending && <div className="alert" role="status"><span>上次行动尚未收到确认。恢复会查询同一请求，已保存的骰子不会重掷。</span><button disabled={busy} onClick={() => void run(async () => {
          let result: { view: View };
          try { result = await api(pending); }
          catch (error) {
            await recoverRejected(error, pending);
            throw error;
          }
          await clearPendingRequest(pending.requestId); setPending(null); setView(result.view); setSection("adventure");
          history.replaceState(null, "", `?adventure=${result.view.game.id}`);
        })}>恢复上次行动</button></div>}
        <header className="topbar">
          <div className="breadcrumb">
            冒险桌 <ChevronRight size={13} />
            <span>
              {section === "lobby"
                ? "模组大厅"
                : section === "characters"
                  ? "我的角色"
                  : section === "camp"
                    ? "营地夜话"
                    : section === "rules"
                      ? "新手手册"
                      : section === "multiplayer" ? "多人组队"
                      : view?.title}
            </span>
          </div>
          <div className="topbar-right">
            <span className="status-pill">
              <span className={data?.aiReady ? "live-dot" : "neutral-dot"} />
              {data?.aiReady ? "AI 主持人已连接" : "规则桌已就绪"}
            </span>
            {data?.local && (
              <button
                className="icon-button"
                aria-label="本机 AI 设置"
                onClick={() => setSettings(true)}
              >
                <Settings2 size={20} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="打开新手帮助"
              onClick={() => setHelp(true)}
            >
              <HelpCircle size={20} />
            </button>
          </div>
        </header>
        {(error || notice) && (
          <div className={`alert ${error ? "error" : ""}`} role="alert">
            <span>{error || notice}</span>
            {error && view && (
              <button
                disabled={busy}
                onClick={() => void run(() => enter(view.game.id))}
              >
                刷新冒险
              </button>
            )}
            <button
              aria-label="关闭提示"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading-screen">
            <Flame size={36} />
            <h1>正在为你点亮冒险桌…</h1>
            <p>读取角色与冒险存档</p>
            <LoaderCircle className="spin" size={22} />
          </div>
        ) : !data ? (
          <div className="empty-state">
            <Flame />
            <h1>冒险桌暂未连接</h1>
            <p>{error || "请登录后重试。"}</p>
            <button
              className="button primary"
              onClick={() => location.reload()}
            >
              重新连接
            </button>
          </div>
        ) : (
          <>
            {section === "multiplayer" && <Multiplayer data={data} back={() => navigate("lobby")} help={() => setHelp(true)} refresh={refresh} />}
            {section === "lobby" && (
              <main className="lobby page-content">
                {data.local && <div className="play-mode-choice"><div><strong>今晚，怎样冒险？</strong><span>单人随时出发，也可以邀请朋友坐到同一张桌边。</span></div><button className="button primary" onClick={() => create()}>单人冒险</button><button className="button secondary" onClick={() => navigate("multiplayer")}><Users size={17} />多人组队</button></div>}
                <section className="hero-banner">
                  <div className="hero-shade" />
                  <div className="hero-copy">
                    <span className="hero-kicker">
                      <span />
                      一盏灯，一场属于你的冒险
                    </span>
                    <h1>
                      故事等你。
                      <br />
                      <em>骰子，交给命运。</em>
                    </h1>
                    <p>
                      走进河谷，成为故事里的人。
                      <br />
                      你的过去、选择和意外，都会留下回声。
                    </p>
                    <button
                      className="button primary hero-cta"
                      onClick={() => create()}
                    >
                      走进月桥河谷 <ArrowRight size={18} />
                    </button>
                    <div className="hero-tags">
                      <span>
                        <Check size={13} />
                        不需要规则基础
                      </span>
                      <span>
                        <Check size={13} />
                        随时离开，自动存档
                      </span>
                    </div>
                  </div>
                  <div className="banner-caption">
                    <span>MOONBRIDGE VALLEY</span>月桥河谷 · 原创冒险世界
                  </div>
                </section>
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">CHOOSE YOUR STORY</p>
                    <h2>今晚，去哪里？</h2>
                    <p>先尝试短篇，也可以把河谷的故事分几晚慢慢展开。</p>
                  </div>
                  <span className="version-note">原创战役 · 自动存档</span>
                </div>
                <div className="campaign-grid">
                  {data.campaigns.map((campaign, index) => (
                    <article
                      className={`campaign-card campaign-${index}`}
                      key={campaign.id}
                    >
                      <div className="campaign-art">
                        <div className="campaign-art-shade" />
                        <span className="campaign-badge">
                          {campaign.id === "moonbridge-conspiracy"
                            ? "持续战役 · 自由探索"
                            : index === 1
                              ? "推荐 · 教学短篇"
                              : "新的抉择"}
                        </span>
                        <span className="chapter-number">0{index + 1}</span>
                        <span className="campaign-symbol">
                          {index === 0 ? (
                            <Flame size={44} />
                          ) : (
                            <Compass size={44} />
                          )}
                        </span>
                      </div>
                      <div className="campaign-info">
                        <div className="campaign-meta">
                          <span>{campaign.theme}</span>
                          <span>
                            <Hourglass size={13} />
                            {campaign.minutes}
                          </span>
                        </div>
                        <h3>{campaign.title}</h3>
                        <p>{campaign.description}</p>
                        <div className="campaign-bottom">
                          <span>
                            <span className="little-dot" />
                            {campaign.difficulty}
                          </span>
                          <button
                            className="button secondary"
                            onClick={() => create(campaign.id)}
                          >
                            选择冒险 <ArrowRight size={15} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                {data.games.length > 0 && (
                  <section className="saved-section">
                    <div className="section-heading compact">
                      <div>
                        <h2>留下的故事</h2>
                        <p>回来时，灯还亮着。</p>
                      </div>
                      <ScrollText size={22} />
                    </div>
                    <div className="saved-list">
                      {data.games.map((saved) => (
                        <button
                          key={saved.id}
                          className="saved-row"
                          disabled={busy}
                          onClick={() => void run(() => enter(saved.id))}
                        >
                          <span className="saved-icon">
                            <ScrollText size={21} />
                          </span>
                          <div>
                            <strong>{saved.title}</strong>
                            <small>
                              {saved.heroNames.join("、")} ·{" "}
                              {saved.mode === "party" ? "组队" : "单人"} ·{" "}
                              {saved.campaignFormat === "situation-v1"
                                ? "持续战役"
                                : `第 ${saved.scene + 1} 幕`}
                            </small>
                          </div>
                          <span className={`saved-status ${saved.status}`}>
                            {saved.status === "complete"
                              ? "已落幕"
                              : saved.status === "waiting"
                                ? "等待队友"
                                : "继续冒险"}
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <section className="first-steps">
                  <div className="section-heading compact">
                    <div>
                      <p className="eyebrow">A LITTLE GUIDANCE</p>
                      <h2>你只需要做三件事</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("rules")}
                    >
                      翻开新手手册 <ArrowRight size={16} />
                    </button>
                  </div>
                  <div className="step-grid">
                    <div>
                      <span>01</span>
                      <h3>成为一个角色</h3>
                      <p>决定身份、技能和装备，再写下羁绊与愿望。</p>
                    </div>
                    <div>
                      <span>02</span>
                      <h3>告诉世界你的想法</h3>
                      <p>观察、交谈、尝试。点选行动，也能自由描述。</p>
                    </div>
                    <div>
                      <span>03</span>
                      <h3>让骰子带来意外</h3>
                      <p>先看规则与代价，再掷骰。成败都让故事继续。</p>
                    </div>
                  </div>
                </section>
              </main>
            )}
            {section === "characters" && (
              <main className="page-content">
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">THE PEOPLE IN YOUR STORIES</p>
                    <h1>我的角色</h1>
                    <p>每一位旅人，都带着还没写完的故事。</p>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => create("moonbridge-conspiracy", true)}
                  >
                    <Plus size={17} />
                    新建角色
                  </button>
                </div>
                {!data.heroes.length ? (
                  <div className="empty-state">
                    <Users size={40} />
                    <h2>从一个名字开始</h2>
                    <p>四种族、三职业。可使用默认分配，也可以逐项定制。</p>
                    <button
                      className="button primary"
                      onClick={() => create("moonbridge-conspiracy", true)}
                    >
                      创建第一位旅人 <ArrowRight size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="character-grid">
                    {data.heroes.map((character) => (
                      <article className="character-card" key={character.id}>
                        <div className="character-card-top">
                          <Avatar hero={character} />
                          <div>
                            <span className="eyebrow">
                              LEVEL 01 · {character.species}
                            </span>
                            <h2>{character.name}</h2>
                            <p>
                              {CLASSES[character.classId].name} ·{" "}
                              {CLASSES[character.classId].subtitle}
                            </p>
                          </div>
                        </div>
                        <p className="character-background">
                          {character.background}
                        </p>
                        <CharacterDetails hero={character} />
                        <div className="card-actions">
                          <button
                            className="button secondary"
                            onClick={() => {
                              setCampHeroId(character.id);
                              navigate("camp");
                            }}
                          >
                            去营地聊聊 <MessageCircle size={15} />
                          </button>
                          <button
                            className="text-button"
                            onClick={() => {
                              create();
                              setHeroId(character.id);
                            }}
                          >
                            带他上路 <ArrowRight size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <p className="subtle-note">
                  角色册保存出发模板。每场冒险独立记录生命和资源，新开一场不会覆盖旧存档。
                </p>
              </main>
            )}
            {section === "camp" && (
              <main className="page-content">
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">BY THE CAMPFIRE</p>
                    <h1>营地夜话</h1>
                    <p>冒险之外，也给旅人一点说话的时间。</p>
                  </div>
                  <Tent size={30} />
                </div>
                {!campHero ? (
                  <div className="empty-state">
                    <Tent size={40} />
                    <h2>篝火旁还空着一个位置</h2>
                    <p>先创建一位角色，再听听他的故事。</p>
                    <button
                      className="button primary"
                      onClick={() => create("moonbridge-conspiracy", true)}
                    >
                      创建角色
                    </button>
                  </div>
                ) : (
                  <div className="camp-layout">
                    <aside className="camp-people">
                      <h3>今晚的旅人</h3>
                      {data.heroes.map((character) => (
                        <button
                          key={character.id}
                          className={`camp-person ${campHeroId === character.id ? "selected" : ""}`}
                          disabled={busy}
                          onClick={() => {
                            setCampHeroId(character.id);
                            setText("");
                          }}
                        >
                          <Avatar hero={character} small />
                          <span>
                            <strong>{character.name}</strong>
                            <small>{CLASSES[character.classId].name}</small>
                          </span>
                        </button>
                      ))}
                      <p>对话保存，用于扮演，不改变冒险数值。</p>
                    </aside>
                    <section className="chat-panel">
                      <div className="chat-heading">
                        <Flame size={19} />
                        <div>
                          <strong>{campHero.name}</strong>
                          <small>篝火未眠</small>
                        </div>
                      </div>
                      {campMessages.length ? (
                        <Transcript messages={campMessages} />
                      ) : (
                        <div className="camp-welcome">
                          <Avatar hero={campHero} />
                          <h2>火光映在{campHero.name}的脸上。</h2>
                          <p>{campHero.background}</p>
                          <div className="prompt-chips">
                            {[
                              "你为什么离开家乡？",
                              "第一次冒险，你紧张吗？",
                              "教我怎么扮演你吧。",
                            ].map((prompt) => (
                              <button
                                key={prompt}
                                onClick={() => setText(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <form
                        className="composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void talk(true);
                        }}
                      >
                        <input
                          aria-label="营地对话"
                          placeholder={
                            data.aiReady
                              ? "问问他的故事，或聊聊你的想法…"
                              : "连接 AI 后，可以在篝火旁聊天"
                          }
                          maxLength={700}
                          value={text}
                          disabled={busy || !data.aiReady}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <button
                          aria-label="发送营地消息"
                          className="send-button"
                          disabled={busy || !data.aiReady || !text.trim()}
                        >
                          {busy ? (
                            <LoaderCircle className="spin" size={18} />
                          ) : (
                            <Send size={18} />
                          )}
                        </button>
                      </form>
                    </section>
                  </div>
                )}
              </main>
            )}
            {section === "rules" && (
              <main className="page-content rules-page">
                <div className="manual-art">
                  <BookOpen size={46} />
                  <span>THE TRAVELER’S HANDBOOK</span>
                </div>
                <RuleContent />
              </main>
            )}
            {section === "adventure" && view && (
              <Adventure
                view={view}
                data={data}
                busy={busy}
                command={command}
                navigate={() => navigate("lobby")}
                help={() => setHelp(true)}
                text={text}
                setText={setText}
                talk={() => talk()}
                legacyProposal={proposal}
                dismissProposal={() => setProposal(null)}
              />
            )}
          </>
        )}
        <footer className="app-footer">
          <span>
            ✦ 灯火之下 v{data?.version || "0.3.0-beta.1"} · 原创故事，透明骰子
          </span>
          <button onClick={() => navigate("rules")}>
            SRD 5.1 教学子集 · CC BY 4.0
          </button>
        </footer>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className="modal builder-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭角色创建"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            <p className="eyebrow">A PERSON, NOT JUST A STAT BLOCK</p>
            <h2 id="modal-title">
              {modal === "hero" ? "给故事一个主角" : "把你的名字，写进故事"}
            </h2>
            <p className="modal-intro">
              {modal === "adventure"
                ? data?.campaigns.find((c) => c.id === campaignId)?.subtitle
                : "先决定你是谁，再决定你擅长什么。"}
            </p>
            {modal === "adventure" && !!data?.heroes.length && (
              <label className="field">
                出发的角色
                <select
                  value={heroId}
                  disabled={busy}
                  onChange={(e) => setHeroId(e.target.value)}
                >
                  <option value="">创建新角色</option>
                  {data.heroes.map((h) => (
                    <option value={h.id} key={h.id}>
                      {h.name} · {CLASSES[h.classId].name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(!heroId || modal === "hero") && (
              <CharacterBuilder
                value={build}
                onChange={setBuild}
                disabled={busy}
              />
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button primary modal-submit"
              disabled={busy || ((!heroId || modal === "hero") && !validBuild)}
              onClick={() => void saveCreation()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : modal === "hero" ? (
                <Check size={18} />
              ) : (
                <ArrowRight size={18} />
              )}{" "}
              {modal === "hero" ? "保存角色" : "准备好了，独自出发"}
            </button>
            <p className="subtle-note">
              一级角色 · 新手救援房规 · 自动存档 · 可从多人组队邀请朋友
            </p>
          </section>
        </div>
      )}
      {settings && (
        <Settings onClose={() => setSettings(false)} onSaved={refresh} />
      )}
      {help && (
        <div
          className="drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHelp(false);
          }}
        >
          <aside
            className="help-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="新手手册"
          >
            <button
              className="icon-button drawer-close"
              aria-label="关闭手册"
              onClick={() => setHelp(false)}
            >
              <X size={21} />
            </button>
            <RuleContent />
          </aside>
        </div>
      )}
    </div>
  );
}
