import { env } from "cloudflare:workers";
import { configureRuntime } from "@/lib/server/runtime";
import { handleGET, handlePOST } from "@/lib/server/service";

export const dynamic = "force-dynamic";
async function handle(request: Request, post: boolean) {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) return Response.json({error: "请先登录 ChatGPT，再进入你的冒险桌。"}, {status: 401});
  if(!env.DB) return Response.json({error:"存档服务暂未就绪。"},{status:503});
  configureRuntime({DB: env.DB, aiReady: !!env.DEEPSEEK_API_KEY, completion: async (system, prompt) => {
    if (!env.DEEPSEEK_API_KEY) throw new Error("AI 主持人暂未连接。你仍可用行动按钮完成冒险。");
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", headers: {Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json"},
      body: JSON.stringify({model: "deepseek-flash", thinking: {type: "disabled"}, temperature: 0.75, max_tokens: 1800,
        response_format: {type: "json_object"}, messages: [{role: "system", content: system}, {role: "user", content: JSON.stringify(prompt)}]}),
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error("AI 主持人暂时无法回应，请稍后再试。");
    const data = await response.json() as {choices?: {message?: {content?: string}}[]};
    return JSON.parse(data.choices?.[0]?.message?.content || "");
  }});
  return post ? handlePOST(request, userId) : handleGET(request, userId);
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
