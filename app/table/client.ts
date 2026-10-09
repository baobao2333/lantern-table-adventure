import type { Hero, View } from "@/lib/game/types";
export type Overview = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  minutes: string;
  theme: string;
  difficulty: string;
  sceneCount: number;
};
export type Saved = {
  id: string;
  title: string;
  status: string;
  mode: string;
  scene: number;
  heroNames: string[];
  roomCode: string;
  campaignFormat?: string;
};
export type Bootstrap = {
  userId: string;
  aiReady: boolean;
  local: boolean;
  version: string;
  heroes: Hero[];
  campaigns: Overview[];
  games: Saved[];
};
export class TableRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}
export function definitivelyRejected(error: unknown) {
  return error instanceof TableRequestError && (["stale_version", "intent_failed"].includes(error.code || "") ||
    (error.status >= 400 && error.status < 500 && error.status !== 409));
}
export async function api<T>(body?: unknown, query = ""): Promise<T> {
  const response = await fetch(
    `/api/table${query}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = (await response.json()) as { error?: string; code?: string };
  if (!response.ok) throw new TableRequestError(data.error || "暂时无法完成操作，请重试。", response.status, data.code);
  return data as T;
}
export type WebTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: object;
  execute: (input: unknown) => unknown;
};
export type ToolContext = {
  view: View | null;
  data: Bootstrap | null;
  enter: (id: string) => Promise<unknown>;
  command: (command: {
    kind: "action" | "roll" | "confirm";
    actionId?: string;
  }) => Promise<unknown>;
};
export function registerTools(read: () => ToolContext) {
  const context = (
    document as Document & {
      modelContext?: {
        registerTool: (
          tool: WebTool,
          options: { signal: AbortSignal },
        ) => void | Promise<void>;
      };
    }
  ).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools: WebTool[] = [
    {
      name: "read_adventure_state",
      title: "Read adventure",
      description:
        "Read the visible saved adventure and available actions without hidden story content.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input) => {
        const { view } = read();
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new Error("Expected empty object");
        return view
          ? {
              id: view.game.id,
              title: view.title,
              scene: view.scene.title,
              status: view.game.status,
              pending: view.game.world?.proposal || view.game.pending,
              world: view.world,
              actions: view.actions.map((a) => ({ id: a.id, title: a.title })),
              heroes: view.game.players.map((p) => ({
                name: p.hero.name,
                hp: p.hero.hp,
              })),
            }
          : { status: "lobby" };
      },
    },
    {
      name: "open_saved_adventure",
      title: "Open saved adventure",
      description:
        "Navigate to an existing adventure in the saved list; does not create a game.",
      inputSchema: {
        type: "object",
        properties: { adventureId: { type: "string" } },
        required: ["adventureId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input) => {
        const { data, enter } = read();
        const id = inputField(input, "adventureId");
        if (!data?.games.some((g) => g.id === id))
          throw new Error("Unknown saved adventure");
        return enter(id);
      },
    },
    {
      name: "choose_adventure_action",
      title: "Choose adventure action",
      description:
        "Choose an available scene action. Checks are staged for separate dice confirmation; automatic actions advance immediately, as in the visible interface.",
      inputSchema: {
        type: "object",
        properties: { actionId: { type: "string" } },
        required: ["actionId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const { view, command } = read();
        const id = inputField(input, "actionId");
        if (!view?.actions.some((a) => a.id === id))
          throw new Error("Action unavailable");
        const result = await command({ kind: "action", actionId: id });
        if (!result) throw new Error("Action failed; see visible error");
        return result;
      },
    },
    {
      name: "confirm_pending_roll",
      title: "Roll pending check",
      description:
        "Resolve the pending check with its visible DC, modifier and stakes. Server rolls and saves the result.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const { view, command } = read();
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length ||
          (!view?.game.pending && !view?.game.world?.proposal)
        )
          throw new Error("No pending check or invalid input");
        const result = await command({
          kind: view!.game.world?.proposal ? "confirm" : "roll",
        });
        if (!result) throw new Error("Roll failed; see visible error");
        return result;
      },
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Optional browser capability. */
    }
  }
  return () => lifecycle.abort();
}
function inputField(input: unknown, field: string): string {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !(field in input)
  )
    throw new Error("Invalid tool input");
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value)
    throw new Error("Invalid tool input");
  return value;
}
