import type { Campaign } from "../game/types";
export type CompletionOptions = { schema?: Record<string, unknown>; maxOutputBytes?: number; timeoutMs?: number; codexReasoningEffort?: "low" | "medium" };
export type Completion = (system: string, prompt: unknown, signal?: AbortSignal, options?: CompletionOptions) => Promise<unknown>;
export type TableRuntime = {
  DB: D1Database;
  aiReady: boolean;
  local?: boolean;
  completion?: Completion;
  campaigns?: () => Campaign[];
};
let current: TableRuntime | undefined;
export function configureRuntime(value: TableRuntime) {
  current = value;
}
export function runtime(): TableRuntime {
  if (!current) throw new Error("Table runtime has not been configured.");
  return current;
}
