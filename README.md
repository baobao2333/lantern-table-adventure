# 灯火之下 · Lantern Table

一张中文 AI 跑团桌，适合第一次尝试扮演角色、掷骰和与主持人共同创造故事的人。你描述想做什么，主持人解释可能的结果与代价；确定行动后，由规则引擎掷骰并保存结果，AI 再写出人物反应和现场细节。

**v0.3.0-beta.2 提供统一 Windows 桌面入口。** 在 [Releases 页面](https://github.com/baobao2333/lantern-table-adventure/releases)下载 `LanternTable-0.3.0-beta.2-Setup.exe`，或解压桌面便携 ZIP 后运行 `LanternTable.exe`。包内包含运行环境，无需安装 Node.js 或 npm。进入后选择单人冒险或多人组队。

本版为预发行。单人、房间规则和真实本机联机已做隔离验收；尚未部署公网辅助服务，也未验证大陆跨运营商连接。服务器申请已按需求暂缓，后续可使用阿里云部署随包提供的信令／STUN 服务。

本次安装包与便携程序**未签名**，Windows 可能显示发布者或信誉提示。已准备受信任证书与 CI 签名流程，取得证书后可重新签名发行；配置见 [Windows 签名说明](docs/windows-signing.md)。发行页的 SHA-256 清单用于核对文件，不替代签名。

## 第一次怎么玩

新手可以先选战士，给角色起一个名字，再写一句他为什么上路。你也可以认真填写角色表；“三只小家伙穿一件斗篷”这样的外观设定可以成为故事，但角色实际拥有的动作、属性和资源仍以角色表为准。

《失声的钟楼》《最后一班渡船》适合先练习检定与选择。《月桥镇：被偷走的月光》使用可回访的地点、人物目的和持续事件，可以多次打开存档继续。你可以使用建议行动，也可以自由描述方法；持续战役会先给出待确认的裁定，显示难度、加值与失败代价，再由你决定是否行动。

长篇 [《潮汐遗嘱：给尚未出生的人》](docs/tide-testament.md) 包含五篇、25 地点、78 个机会和三种最终方案，适合分多晚探索。当前角色仍使用一级规则子集，预估 8–15 小时随讨论与阅读速度变化，不包含升级系统。

想写自己的故事，从侧栏进入 **剧本工坊**：使用本机 AI 生成草稿，或下载规范交给其他 AI，再导入 JSON。通过检查并保存后即可创建冒险；修订不会改写旧存档。操作与格式边界见 [剧本工坊说明](docs/workshop.md)。

每次行动都会保存。返回大厅、关闭浏览器或下次启动后，都能继续同一位角色的冒险。暂停程序本身不会推进世界时间；游戏里的行动、赶路和休息才会改变局势。营地对话用于了解与扮演角色，不能直接改变生命、装备或线索。

## 连接 AI

在页面的 **AI 设置** 中选择：

| 方式 | 需要准备什么 |
| --- | --- |
| 兼容 API | 支持 Chat Completions 与 JSON 输出的服务地址、模型名称和自己的 API 密钥。例：`https://api.openai.com/v1`；不要追加 `/chat/completions`。 |
| Codex CLI | 在应用设置中点击安装官方 CLI，再点击登录，在系统浏览器完成官方登录。模型可留空使用 CLI 默认。首次下载约 160 MB，可取消；已有可信 CLI 也可使用。 |
| 暂不连接 | 可以创建角色、阅读规则并使用可见规则行动；AI 对话与叙事需要连接后使用。 |

保存设置后点击连接测试。兼容 API 使用对应服务商的账户、模型权限和计费；Codex 使用已登录账户的权限与额度。两种连接都需要能够访问相应服务。

API 密钥只由本机服务使用，浏览器只会知道是否已保存。Windows 当前账户的 DPAPI 会加密本机密钥文件。桌面角色、冒险和设置保存在 `%LOCALAPPDATA%\LanternTable\desktop`，移动或更新程序目录不会清空存档。备份前先停止服务，再复制整个数据目录；换 Windows 账户后需要重新配置 AI。完整启动与恢复说明见 [本机版说明](local/README_CN.md)。

多人模式由房主提供 AI 连接并保存权威存档，参加者不填写或获取房主凭据。默认使用自部署信令／STUN 协商 P2P，游戏数据直接连接房主；也支持高级 WSS 地址直连。没有 TURN 中继，部分 NAT 或封锁 UDP 的网络需要公网 IPv6、IPv4 端口映射或更换房主。准备、时限、断线与重启后的恢复步骤见 [多人使用与协议](docs/multiplayer.md)，部署见 [辅助服务说明](signal/README_CN.md)。

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
npm run build:desktop
npm run release:desktop
npm run verify:desktop
npm run release:signal
```

桌面打包锁定 Electron、Node 与原生传输依赖，验证官方 Node 校验和，再打包允许的运行文件与依赖许可；不会包含开发环境变量、登录文件或用户数据。安装版与便携版位于 `dist/desktop/release`，辅助服务 ZIP 位于 `dist/release`。版本清单、原生库指纹和 SHA256 一同交付。推送匹配的 `v*` 标签触发 Windows CI；带 beta 后缀的版本发布为 GitHub 预发行。旧的 `release:windows` 浏览器启动包仍保留供开发验收，推荐使用桌面发行包。

云端 Sites 入口继续使用平台身份与 D1；共享的规则、服务和叙事模块由运行时注入连接。源码开发、内容格式与职责分工见 [架构地图](docs/architecture.md)、[持续战役格式](docs/world-format.md)、[持续战役生成提示词](docs/world-generation-prompt.txt) 与 [短篇剧本格式](docs/campaign-format.md)。

## 来源与许可

This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at [SRD 5.1](https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf). The SRD 5.1 is licensed under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/legalcode). Rules translated and adapted. Adventures and visual identity are original. This is an independent project.

Node.js 及其他发行依赖的许可保留在安装包中。参考同类网站只用于研究跑团产品的交互，没有复制其品牌、账号、故事或美术资源。
