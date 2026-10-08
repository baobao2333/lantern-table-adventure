# 灯火之下 · Lantern Table

一张中文 AI 跑团桌，适合第一次尝试扮演角色、掷骰和与主持人共同创造故事的人。你描述想做什么，主持人解释可能的结果与代价；确定行动后，由规则引擎掷骰并保存结果，AI 再写出人物反应和现场细节。

**Windows 本机版已经包含运行环境。** 在 [Releases 页面](https://github.com/baobao2333/lantern-table-adventure/releases)下载 Windows x64 ZIP，完整解压，双击 `START.cmd`。无需安装 Node.js 或 npm。浏览器打开 `http://127.0.0.1:4173` 后，创建角色，选择冒险即可开始。

## 第一次怎么玩

新手可以先选战士，给角色起一个名字，再写一句他为什么上路。你也可以认真填写角色表；“三只小家伙穿一件斗篷”这样的外观设定可以成为故事，但角色实际拥有的动作、属性和资源仍以角色表为准。

《失声的钟楼》《最后一班渡船》适合先练习检定与选择。《月桥镇：被偷走的月光》使用可回访的地点、人物目的和持续事件，可以多次打开存档继续。你可以使用建议行动，也可以自由描述方法；持续战役会先给出待确认的裁定，显示难度、加值与失败代价，再由你决定是否行动。

每次行动都会保存。返回大厅、关闭浏览器或下次启动后，都能继续同一位角色的冒险。暂停程序本身不会推进世界时间；游戏里的行动、赶路和休息才会改变局势。营地对话用于了解与扮演角色，不能直接改变生命、装备或线索。

## 连接 AI

在页面的 **AI 设置** 中选择：

| 方式 | 需要准备什么 |
| --- | --- |
| 兼容 API | 支持 Chat Completions 与 JSON 输出的服务地址、模型名称和自己的 API 密钥。例：`https://api.openai.com/v1`；不要追加 `/chat/completions`。 |
| Codex CLI | 安装并登录 [官方 Codex CLI](https://learn.chatgpt.com/docs/codex-cli)，运行 `codex login` 后重启游戏。沿用已登录账户；模型可留空使用 CLI 默认。 |
| 暂不连接 | 可以创建角色、阅读规则并使用可见规则行动；AI 对话与叙事需要连接后使用。 |

保存设置后点击连接测试。兼容 API 使用对应服务商的账户、模型权限和计费；Codex 使用已登录账户的权限与额度。两种连接都需要能够访问相应服务。

API 密钥只由本机服务使用，浏览器只会知道是否已保存。Windows 当前账户的 DPAPI 会加密本机密钥文件。角色、冒险和设置保存在 `%LOCALAPPDATA%\LanternTable`，移动或更新程序目录不会清空存档。备份前先停止服务，再复制整个数据目录；换 Windows 账户后需要重新配置 AI。完整启动与恢复说明见 [本机版说明](local/README_CN.md)。

0.2 本机版只接受这台电脑的 `127.0.0.1` 连接，面向单人游玩。局域网多人属于 [0.3 计划](ROADMAP.md)：由房主提供 AI 连接，参与者不填写或获取房主凭据。

## 当前规则范围

本项目改编自 **D&D SRD 5.1（2014）**，提供四种族、一级战士、游荡者和法师、18 项技能、六种戏法与七种一环法术，使用已实现的规则，并公开列出房规。角色表和当前界面的规则说明是实际支持范围；背景声明不能变成额外能力，说服不会强迫人物服从，自然 20 也不保证普通检定成功。

AI 可以理解表达、澄清意图、提出有限裁定并叙事。规则引擎拥有骰子、生命、资源、状态和线索的最终决定权。当前实现仍有边界：复杂物理模拟、任意新法术和完整桌面版规则没有实现。服务暂时中断时，已结算的规则结果仍然保留，重复同一请求不会重新掷骰。

## 从源码运行

Windows 发行构建使用 Node.js 24.21.0；源码需要安装依赖。推荐使用同一版本，以便直接运行内置 SQLite 与测试。

```sh
npm ci
npm run content:check
npm test
npx tsc --noEmit
npm run build:local
node scripts/verify-local.mjs
```

构建后的本机程序位于 `dist/local`，可用 `node dist/local/server.mjs` 启动。生成 Windows ZIP 并验收完整发行包：

```sh
node scripts/check-release-version.mjs
node scripts/package-release.mjs
node scripts/verify-release.mjs
```

本机打包使用 Windows PowerShell，下载固定版本的官方 Node.js，验证官方与仓库固定的 SHA256，再打包明确允许的运行文件。产物位于 `dist/release`，不会打包 `node_modules`、开发环境变量、登录文件或用户数据。推送与版本一致的 `v*` 标签后，Windows CI 会完成校验、构建、安装包验收，并创建或更新对应的正式 GitHub Release。

云端 Sites 入口继续使用平台身份与 D1；共享的规则、服务和叙事模块由运行时注入连接。源码开发、内容格式与职责分工见 [架构地图](docs/architecture.md)、[持续战役格式](docs/world-format.md)、[持续战役生成提示词](docs/world-generation-prompt.txt) 与 [短篇剧本格式](docs/campaign-format.md)。

## 来源与许可

This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at [SRD 5.1](https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf). The SRD 5.1 is licensed under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/legalcode). Rules translated and adapted. Adventures and visual identity are original. This is an independent project.

Node.js 及其他发行依赖的许可保留在安装包中。参考同类网站只用于研究跑团产品的交互，没有复制其品牌、账号、故事或美术资源。
