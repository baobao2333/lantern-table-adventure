# 架构地图

规则与存档是权威，AI 负责解释与叙事。云端和本机入口调用同一个服务；它们只负责提供身份、数据库和 AI 连接。浏览器拿到公开视图，不保存完整世界或模型凭据。

```text
Home / character builder / AI settings
                  |
              /api/table
                  |
        lib/server/service.ts
          /        |        \
     rule engine  repository  narrator
          |        |          |
  content snapshot DB     runtime.completion

cloud: app/api/table/route.ts -> platform user + D1 + cloud provider
local: local/server.ts       -> local-owner + SQLiteD1 + local provider
```

## 入口与模块

| 模块 | 负责的事情 |
| --- | --- |
| `app/table/home.tsx`、`character-builder.tsx`、`adventure.tsx`、`world-panel.tsx`、`components.tsx` | 大厅、角色创建、冒险桌、可读规则与公开日志；玩家先确认裁定，再结算。 |
| `app/table/client.ts` | API 客户端、公开类型和可选浏览器工具；工具与可见操作共用处理器。 |
| `app/api/table/route.ts` | 云端身份入口，注入 D1 与云端 AI 连接，再交给共享服务。 |
| `local/server.ts` | 本机 HTTP 入口；固定绑定 `127.0.0.1`，验证 Host、Origin、Fetch-Site 和请求体大小；服务静态前端与本机设置。 |
| `lib/server/service.ts` | 请求格式、角色与成员权限、版本检查、行动编排；先提交规则结果，再请求补充叙事。 |
| `lib/server/runtime.ts` | 当前运行环境的唯一注入点：`DB`、`completion`、`aiReady`、`local`。核心模块不引用 Cloudflare 或 Node HTTP。 |
| `lib/server/repository.ts` | 数据库保存、行动租约、版本提交、成员关系、请求去重与营地记录。 |
| `local/sqlite.ts` | 用 Node 内置 SQLite 实现 repository 实际需要的 D1 结构；迁移记账与 batch 原子事务。 |
| `lib/game/engine.ts`、`dice.ts`、`spells.ts` | 独立规则与骰子结算；不调用 AI 或数据库。 |
| `lib/game/world-engine.ts`、`world-types.ts` | 持续战役的地点、目标、时钟、关系、准备与待确认裁定；拒绝非法引用和不受支持的状态变化。 |
| `lib/game/character-builder.ts`、`characters.ts`、`types.ts` | 角色表创建、合法选择与规则数值；背景是人物声明，不能覆盖实际能力。 |
| `lib/server/narrator.ts` | 构造当前公开上下文，校验模型输出，区分问题、建议与叙事；不提供未获得的世界秘密。 |
| `local/provider.ts` | 兼容 API 与官方 Codex CLI 连接；Codex JSON schema 分别覆盖叙事、短篇行动与持续战役裁定。 |
| `local/settings.ts` | 本机设置保存；API 密钥用 DPAPI CurrentUser 加密，公开设置只包含 `hasKey`。 |

## 权威与存档

`content/campaigns/*.json` 和 `content/worlds/*.json` 是故事内容来源，分别受 `campaign.schema.json` 和 `world.schema.json` 约束。`scripts/content-workflow.mjs` 检查结构、引用和语义，并生成 `lib/game/*-content.generated.mjs`。修改 JSON 后运行 `npm run content:sync`；不要直接编辑生成注册表。

创建冒险时复制内容快照，使已有存档不会被一次内容更新悄悄改写。数据库保存角色、冒险、成员关系和营地日志。云端使用 D1，本机使用 `%LOCALAPPDATA%\LanternTable\adventures.sqlite`。浏览器的公开视图与页面状态不承担存档权威。

写入先取得行动租约，核对 `expectedVersion` 与 `requestId`。已经结算的骰子与资源先保存；AI 超时不能造成重掷或重复消耗。最近的请求 ID 与存档版本防止重放和过期页面写入。SQLite batch 必须全部提交或全部回滚。

自由输入先经过意图理解，再由规则核心接受或拒绝对应裁定。服务器决定 DC、奖励、资源和可接触目标；模型不能仅凭一段文字产生神器、未来线索或强制服从。地点可以回访，世界时钟跟随已结算的行动与休息，关闭程序不会推动时钟。

## 本机设置边界

`GET /api/settings` 返回 `{config:{provider,baseUrl,model,hasKey,codexAvailable}}`。`POST` 支持 `op:"save"` 和 `op:"test"`；省略 `apiKey` 时保留原密钥，连接测试使用已经保存的设置。保存后的原始密钥不返回浏览器，也不进入存档视图或错误响应。

兼容 API 地址使用 HTTPS，只有明确的 localhost 服务允许 HTTP，凭据、查询参数和片段不能写进地址。响应体和等待时间都有上限；错误不回传服务商原文或请求内容。

Codex 使用已安装的官方入口与当前用户登录，直接传参数和 stdin，不通过 shell 拼接提示词。每次调用使用临时空工作目录、只读 sandbox、ephemeral 会话和输出 schema；`--ignore-user-config` 保留登录认证并跳过用户连接配置，`--ignore-rules` 跳过个人或项目执行规则，项目说明读取上限设为 0。禁用 shell、浏览器、插件和其他相关工具，不再逐项覆盖 MCP：不完整的 server 配置会丢失 transport，导致 CLI 无法启动。超时或停止本机服务时结束子进程；临时输出随后清理。各账户的访问权限与使用额度仍由服务商决定。真实 JSON 冒烟验证使用 Codex CLI 0.149.1；旧 CLI 不支持这些选项时需要更新。选项含义见[官方 CLI 说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

## 构建与验收

| 命令/脚本 | 检查或产物 |
| --- | --- |
| `npm run content:check` | 内容格式、引用、语义和生成注册表一致。 |
| `npm test`、`npx tsc --noEmit` | 规则、角色创建、仓储 SQL、本机 SQLite 与输出 schema 回归；类型检查。 |
| `scripts/check-release-version.mjs` | package、锁文件、本机元数据、服务器常量、启动说明、更新记录与标签版本一致。 |
| `scripts/build-local.mjs` | Vite 静态客户端与 esbuild Node 服务端；复制真实迁移和依赖许可。 |
| `scripts/verify-local.mjs` | 隔离数据目录中的实际 HTTP 边界、持久存档、DPAPI 密钥和兼容 API fixture；不使用个人凭据。 |
| `scripts/package-release.mjs` | 官方 Node ZIP 校验、明确文件 allowlist、许可证、ZIP 与逐文件 SHA256。 |
| `scripts/verify-release.mjs` | 解压最终 ZIP，检查文件与秘密排除，再用包内 Node 启动包内服务完成回归。 |
| `.github/workflows/windows-release.yml` | Windows 依次验收并上传产物；合法版本标签创建或更新正式 Release。 |

实际账户的 AI 连通与浏览器交互需要在最终集成版另外验证；fixture 回归只证明调用协议、状态保存和凭据边界。Sites 云端发布仍由 `.openai/hosting.json` 与相应生命周期脚本管理。

根目录的 `CHANGELOG.md` 与 `ROADMAP.md` 是发布记录和计划的唯一来源，构建会原样复制到安装包；`local/README_CN.md` 单独维护离线启动与恢复说明。
