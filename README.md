# 灯火之下 · Lantern Table

为第一次跑团设计的中文私人冒险桌。选择一级战士、游荡者或法师，进入原创短篇；先看检定难度、加值与代价，再掷骰。AI 扮演人物、理解自由表达并叙事，服务端规则引擎决定骰子、生命、资源、线索和结局。

包含《失声的钟楼》《最后一班渡船》、营地角色对话、云端存档和最多 4 人的房间。开始组队前需要让朋友获得网站访问权限；房间邀请码本身不授权网站访问。网站默认私人发布。

## 开始玩

打开网站并使用 ChatGPT 登录，点击“开启第一场冒险”。第一次推荐战士：取一个名字，可以补一句为何上路。留意行动卡的“无需掷骰”与“DC”；自由输入会产生主持人答复或行动建议，采用建议后才进行规则操作。冒险会自动保存，返回大厅或刷新后可以继续。

这是 SRD 5.1（2014）教学子集。抽象站位、危险刻度和全队救援是公开房规。没有完整职业、移动格、反应、标准死亡豁免、长休、升级或任意自创法术。支持范围在网站“新手手册”里。AI 叙事仍可能出现表述偏差，以可见规则记录为准；它不能修改存档数值。服务中断时仍可使用规则按钮，已经结算的行动不会为补叙事而重掷。

## 开发与剧本

需要 Node.js 22.15+（本项目验收使用 Node.js 25）。安装依赖后，本地开发使用 `npm run dev`，访问终端给出的确切地址。开发环境使用 Sites 内置本地登录，生产使用平台认证，没有自建账号密码。

服务器环境变量 `DEEPSEEK_API_KEY` 启用真实 AI；密钥只放在 Sites 环境变量或忽略的 `.dev.vars`。没有密钥时，规则冒险仍可玩，营地对话会说明未连接。模型使用 `deepseek-flash` 的 JSON 输出，单次调用最多等待 25 秒。

```sh
npm run content:check
npm test
npm run build
npm run dev
```

D1 绑定名为 `DB`，表结构在 `db/schema.ts`，迁移在 `drizzle/`。首次本地构建后应用迁移：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_material_zaladane.sql
```

扩展内容看 [剧本格式](docs/campaign-format.md) 与 [AI 生成提示词](docs/campaign-generation-prompt.txt)。新增 JSON 后 `npm run content:sync` 会校验、格式化并注册到大厅。构建同样会进行这一步；不合格内容不能进入部署包。

## 架构地图

| 入口/模块 | 职责与数据所有者 |
| --- | --- |
| `app/page.tsx` → `app/table/home.tsx` | 平台登录入口与交互界面；客户端只持有公开视图 |
| `app/table/components.tsx`、`app/table/client.ts` | 可读规则、角色/骰子展示、API 客户端；WebMCP 与按钮共用实际处理器 |
| `app/api/table/route.ts` | 鉴权、输入/来源校验、动作编排；每次写入核对存档版本 |
| `lib/game/engine.ts`、`characters.ts`、`types.ts` | 独立规则核心、一级模板与显式接口；不调用数据库或 AI |
| `content/campaign.schema.json`、`content/campaigns/*.json` | 配置结构权威与故事内容权威 |
| `content-validation.mjs`、`scripts/content-workflow.mjs` | JSON/引用/可达性校验与生成注册表；不执行配置代码 |
| `lib/server/repository.ts` | D1 持久存档、成员权限、行动租约与请求去重 |
| `lib/server/narrator.ts` | 服务端 AI 调用，校验输出，只接收当前场景与已知线索 |
| `tests/*.test.mjs` | 规则回归、全失败通路、结局可达、配置错误反例；仓储 SQL 在内存 SQLite 上验证权限/租约/事务 |
| `scripts/api-smoke.mjs` | 可选本地 D1/HTTP 验收，包含实际 AI、版本冲突与重复请求；会创建验收存档，只允许已知预览地址 |

依赖方向：界面 → API 编排 → 规则核心/存档/叙事；规则核心只依赖配置和角色定义。D1 是存档唯一权威，localStorage 不承载游戏数据。创建存档即复制剧本快照；浏览器只能得到当前场景与已经获得的线索。一个房间的写操作持有 90 秒租约，规则结果先提交，再请求 AI。重复请求返回已保存结果，过期页面的动作被拒绝；客户端避免重复点击。请求去重记录最近 100 次操作，版本检查同时防止旧页面操作新状态。

Sites 发布由项目的 `.openai/hosting.json` 和官方生命周期脚本管理。不要将密钥放进源码、构建文件、Git 参数或浏览器。源代码位于本独立项目目录，未修改上层旧游戏项目。

## 来源与许可

This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode. Rules translated and adapted. Adventures and visual identity are original. Independent project, not an official D&D product.

参考网站仅用于理解“模组大厅 → 角色 → 冒险桌”的结构，没有复制其故事、品牌、账号或美术资源。大厅河谷插画为本项目生成。
