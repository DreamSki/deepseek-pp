# DeepSeek++

为 [DeepSeek](https://chat.deepseek.com) 网页版注入 **类原生工具调用**、**MCP 工具系统**、**Agentic 记忆系统**、**Skill 技能系统**、**系统提示词预设**、**Agent 式持续执行** 和 **自动化任务** 的 Chrome / Edge / Firefox 扩展。

让 DeepSeek 像支持原生 tools 一样自动执行记忆保存、更新、删除和 MCP 工具调用，拥有跨对话长期记忆，并通过 `/skill` 指令一键切换专家模式。Agent 式持续执行让模型像 Claude Code / Codex 一样，在工具调用、结果回传和下一步生成之间持续推进任务；自动化任务则负责把固定任务放进独立会话里立即触发或按计划触发。

## 核心功能

### 类原生工具调用

- **自动识别与执行** — 模型输出工具调用请求后，扩展自动识别并执行，不需要用户复制或手动确认
- **隐藏原始调用** — 页面不会暴露工具调用的技术细节，只展示简洁的执行结果
- **原生观感** — 执行结果渲染成类似「已思考」的折叠区块，例如「已执行工具（2次）」并逐条展示结果
- **多工具连续执行** — 同一条回复可以执行多次工具调用，适合把多个独立事实分别保存为多条记忆
- **刷新后恢复** — 工具执行记录在刷新会话后仍能恢复展示
- **速度显示** — 回复生成时在输入框旁显示实时 `tok/s`，便于判断当前会话是否仍在高速输出

<p align="center">
  <img src="assets/yuansheng.jpg" width="300" alt="工具调用效果">
</p>

### Agent 式持续执行

- **持续推进任务** — 像 Claude Code / Codex 一样，模型可以根据工具结果继续决定下一步，而不是只执行一次工具后停住
- **分步续跑** — MCP 工具结果会回传到同一会话继续生成，直到任务完成或不再需要调用工具
- **Step 折叠区** — 连续执行过程按 Step 展示，已完成步骤自动折叠，长任务不会淹没正文
- **刷新后恢复** — 页面刷新后仍能恢复最近的工具执行过程和最终状态
- **可手动停止** — 长任务执行中可以直接停止后续续跑

<p align="center">
  <img src="assets/screenshot-inline-tools.svg" width="720" alt="工具续跑与速度显示">
</p>

### 悬浮宠物

- **状态联动** — DeepSeek 页面可显示「DeepSeek 小鲸鱼」，会跟随思考、输出、工具执行、成功和失败状态切换反馈
- **位置可调** — 支持固定在左下或右下，也可以直接拖动到自定义位置
- **外观可调** — 设置页可调整尺寸、透明度和动态漂浮效果
- **本地保存** — 开关、位置和外观配置保存在浏览器本地，刷新后继续生效

<p align="center">
  <img src="public/pet/deepseek-whale-pet-states.png" width="420" alt="DeepSeek 小鲸鱼状态">
</p>

### MCP 工具系统

- **支持多种传输方式** — 支持 Streamable HTTP、SSE、本地 stdio bridge 和浏览器 Native Messaging
- **默认自动执行** — 新增 MCP 服务默认自动执行，可在侧边栏按服务或单个工具切换为手动
- **权限管理** — 侧边栏可直接授权、测试连接、刷新工具和查看状态
- **结果自动回传** — 工具执行完成后，结果自动发回同一会话继续生成，实现多轮工具调用
- **支持 Agent 式续跑** — MCP 工具结果可以回传到原会话继续生成，支撑长任务里的多步工具执行
- **本地安全** — MCP 配置和密钥保存在浏览器本地，WebDAV 同步不会同步敏感信息

<p align="center">
  <img src="assets/screenshot-sidepanel-mcp.svg" width="300" alt="MCP 管理侧边栏">
</p>

### OfficeCLI 文档工具

- **内置 `/officecli` skill** — 面向 `.docx`、`.xlsx`、`.pptx` 的检查、问题定位、验证和受控修改流程
- **官方 Skill 库** — 内置 OfficeCLI 官方的 DOCX、XLSX、PPTX、Pitch Deck、Academic Paper、Financial Model、Dashboard、Morph PPT 等场景技能
- **官方样式库** — 内置 OfficeCLI 官方 PPT styles 索引和样式说明，可用 `/officecli-pptx /officecli-styles ...` 链式加载完整视觉风格
- **通过 Shell MCP 执行** — 侧边栏创建 `Shell` 预设后，模型通过 `shell_exec` 调用本机命令版 OfficeCLI
- **自动安装命令版** — `shell:install` 会按系统和 CPU 架构从 iOfficeAI/OfficeCLI 官方发布资产安装单二进制
- **命令版优先** — skill 会先检查 `officecli --help` 是否包含 `view/get/set/batch` 等脚本化命令
- **拒绝额度生成路径** — 如果当前二进制只有 `new --prompt` 这类 hosted AI 生成能力，skill 会停止并提示切换 OfficeCLI 二进制
- **真实本机路径** — 文档路径由用户提供或通过 Shell MCP 查询，不猜测占位目录

安装 Shell Native Host：

```bash
npm run shell:install -- --browser chrome --extension-id <扩展ID>
```

这个命令会同时安装 Shell Native Host 和命令版 OfficeCLI。然后在侧边栏 `MCP` 页点击 `Shell` 创建预设，点击测试和刷新工具。命令版 OfficeCLI 可继续使用 `create/get/set/view/batch/validate` 等脚本化命令，不走 `new --prompt` 的 hosted 生成额度。

### 记忆系统

- **自动记忆** — AI 在对话中识别到关键信息时，自动保存为长期记忆
- **智能注入** — 每次对话时，根据关键词匹配、置顶权重、访问频率等维度，自动筛选相关记忆注入上下文
- **四种类型** — 用户画像 (`user`)、行为反馈 (`feedback`)、话题上下文 (`topic`)、参考资料 (`reference`)
- **侧边栏管理** — 查看、编辑、置顶、删除记忆，支持按类型筛选和标签管理
- **导入/导出** — JSON 格式批量备份和恢复

<p align="center">
  <img src="assets/screenshot-sidepanel-memory.png" width="300" alt="记忆管理侧边栏">
</p>

### Skill 技能系统

- **内置技能** — 预设多组开箱即用的技能，包含通用协作技能和 OfficeCLI 官方文档技能
- **自定义技能** — 在侧边栏创建专属技能，定义系统指令和参数
- **`/` 触发** — 在聊天框输入 `/` 弹出自动补全面板，选择技能后自动注入对应的 system prompt
- **记忆联动** — 技能可选择是否同时注入记忆上下文

<p align="center">
  <img src="assets/screenshot-skill-popup.png" width="600" alt="技能自动补全弹窗">
  <br>
  <img src="assets/screenshot-sidepanel-skill.png" width="300" alt="技能管理侧边栏">
</p>

### 系统提示词预设

- **自定义预设** — 在侧边栏创建多个系统提示词预设，定义全局角色设定或行为指令
- **一键激活** — 同一时间只有一个预设处于激活状态，激活后自动生效
- **首条注入** — 每次新对话的首条消息前自动注入激活预设的内容
- **与技能/记忆共存** — 预设内容与 Skill 指令和记忆上下文叠加生效

### 自动化任务

- **手动或定时触发** — 在侧边栏「自动化」页创建任务，点击「立即运行」或设置 cron/RRULE 后，由扩展自动把任务发送到 DeepSeek
- **每个任务独立会话** — 首次运行自动创建独立会话，后续运行复用该会话，适合连续追踪同一主题
- **灵活调度** — 支持手动触发、cron 表达式（如 `0 9 * * *`）和 RRULE（如 `FREQ=HOURLY;INTERVAL=1`），最小间隔 15 分钟
- **可暂停、编辑和删除** — 任务卡片支持暂停/启用、编辑 prompt 与频率、删除任务，以及打开对应会话
- **运行状态可追踪** — 展示下次运行、上次运行、最近状态和错误信息
- **复用增强链路** — 自动化负责触发任务；触发后的 prompt 仍可经过预设、记忆、MCP 工具和 Agent 式续跑链路

<p align="center">
  <img src="assets/screenshot-sidepanel-automation.svg" width="300" alt="自动化任务侧边栏">
</p>

## 0.4.1 变更回顾

0.4.1 是基于 0.4.0 的体验增强版本，重点引入 DeepSeek 页面悬浮宠物，并把 README 的版本历史继续保持为可折叠回顾。

| 方向 | 主要变化 |
|------|----------|
| 悬浮宠物 | 新增「DeepSeek 小鲸鱼」悬浮宠物，可在 DeepSeek 页面跟随思考、输出、工具执行、成功和失败状态展示不同反馈。 |
| 个性化设置 | 设置页新增宠物开关、左下/右下位置、拖动自定义位置、尺寸、透明度和动态漂浮控制。 |
| 状态持久化 | 宠物开关、位置和外观配置保存在浏览器本地，刷新页面后保持用户选择。 |
| 发布文档 | README 新增悬浮宠物功能介绍和 0.4.1 变更回顾，并保留 0.4.0 / 0.3.0 / 0.2.0 的折叠历史。 |

<details>
<summary>展开 0.4.0 变更回顾</summary>

### 0.4.0 变更回顾

0.4.0 延续 0.3.0 的多浏览器发布基线，重点补齐本机 Shell / Office 文档工具、Agent 式持续执行、自动化任务触发、速度显示和稳定性修复。

| 方向 | 主要变化 |
|------|----------|
| OfficeCLI 文档工具 | 内置 OfficeCLI 官方 Skill 与样式库，新增 Shell MCP 预设和安装脚本，让 DeepSeek 可以通过本机命令版 OfficeCLI 检查、读取、修改和验证 Office 文件。 |
| Agent 式持续执行 | MCP 工具结果可以回传到同一会话继续生成，让 DeepSeek 像 Claude Code / Codex 一样根据执行结果持续决定下一步；页面按 Step 折叠展示连续执行过程，并支持停止与刷新恢复。 |
| 输出速度显示 | 回复生成时显示实时 `tok/s`，更容易判断当前会话的输出状态。 |
| 自动化任务 | 自动化负责手动或定时触发任务，继续支持独立会话、立即运行、cron/RRULE 调度、暂停/编辑/删除，并可复用 Agent 式续跑链路。 |
| 稳定性修复 | 修复流式取消、计时器清理、工具解析计数、多片段偏移和工具记录恢复等问题，减少长任务中的重复执行和状态丢失。 |
| 验证脚本 | 补充 Shell MCP smoke check、MCP mock 验证和工具续跑契约检查，发布前覆盖编译、构建、打包和本机工具链路。 |

</details>

<details>
<summary>展开 0.3.0 变更回顾</summary>

### 0.3.0 变更回顾

0.3.0 以 0.2.0 的 MCP 和自动化平台为基线，重点把扩展从 Chrome 单目标发布推进到 Chrome / Edge / Firefox 多浏览器交付，并补齐主题一致性、版本展示和发布资产链路。

| 方向 | 主要变化 |
|------|----------|
| 跨浏览器支持 | 新增 Chrome、Edge、Firefox MV3 构建与打包脚本；manifest 会按目标浏览器生成权限、侧栏入口和 Firefox 标识，避免把 Chromium-only 能力发到 Firefox。 |
| 发布流程 | Release workflow 改为一次上传 Chrome / Edge / Firefox / sources 多个 zip；安装文档、MCP 操作说明和 mock 验证说明也改成浏览器中立口径。 |
| 侧边栏体验 | 侧边栏顶部导航改为稳定 tab 组件，补齐图标、当前页语义和紧凑布局，适配更多浏览器侧栏宽度。 |
| 深浅色一致性 | DeepSeek 页面主题会同步到侧边栏；记忆、MCP、设置、Skill 弹窗、工具执行卡片和自定义背景遮罩都适配明暗主题。 |
| 版本一致性 | `package.json`、lockfile、manifest 和运行时展示同步到 0.3.0；侧边栏右上角、设置页底部和 MCP clientInfo 都从扩展 manifest 读取版本。 |
| 文档归档 | 将 MCP rollout 文档迁入归档目录，新增 Edge/Firefox 支持归档，保留验证记录和后续手动测试线索。 |

</details>

<details>
<summary>展开 0.2.0 变更回顾</summary>

### 0.2.0 变更回顾

0.2.0 汇总了 0.1.0 以来的主要增量，重点是把 DeepSeek++ 从“记忆 + Skill”扩展升级为完整的浏览器端工具平台。

| 方向 | 主要变化 |
|------|----------|
| MCP 工具系统 | 新增 MCP 服务配置、工具发现、健康检查、调用历史、结果大小限制和超时控制；手动聊天和自动化任务都能自动执行 MCP 工具并把结果回传到同一会话。 |
| 工具调用内核 | 从固定记忆工具扩展为动态工具契约；工具 schema、解析、流式过滤、历史清理和 prompt 注入都支持内置工具与 MCP 工具。 |
| 自动化任务 | 新增侧边栏自动化页、任务编辑器、立即运行、cron/RRULE 调度、暂停/恢复、独立 DeepSeek 会话、运行历史和失败状态展示。 |
| 记忆系统 | 新增记忆更新/删除工具，优化相关记忆筛选、思考模式、自动清理和工具执行折叠展示，刷新页面后能恢复刚执行过的工具状态。 |
| Skill 与预设 | 新增 `/skill` 自动补全面板、内置/自定义技能管理、系统提示词预设、预设导入，以及 DeepSeek Expert 模式切换。 |
| 同步与个性化 | 新增 WebDAV 同步记忆、Skill 和预设；新增 DeepSeek 页面自定义背景、动态透明度和模糊控制。 |
| 文档与发布 | 增补侧边栏截图、MCP 操作说明、mock 验证脚本、TypeScript 修复、release workflow 和构建打包流程。 |

<p align="center">
  <img src="assets/screenshot-sidepanel-mcp.svg" width="300" alt="MCP 管理侧边栏">
  <img src="assets/screenshot-sidepanel-automation.svg" width="300" alt="自动化任务侧边栏">
</p>

</details>

## 安装

### 从源码构建

```bash
git clone https://github.com/zhu1090093659/deepseek-pp.git
cd deepseek-pp
npm install
npm run build
```

默认 `npm run build` 生成 Chrome MV3 产物。跨浏览器构建：

```bash
npm run build:chrome
npm run build:edge
npm run build:firefox
npm run build:all
```

Shell MCP host 的 smoke check：

```bash
npm run smoke:shell
```

| 浏览器 | 加载入口 | 构建目录 |
|--------|----------|----------|
| Chrome | `chrome://extensions/` → 加载已解压的扩展程序 | `dist/chrome-mv3/` |
| Edge | `edge://extensions/` → 加载解压缩的扩展 | `dist/edge-mv3/` |
| Firefox | `about:debugging#/runtime/this-firefox` → 临时载入附加组件 | `dist/firefox-mv3/manifest.json` |

## 友情链接

- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — AI-friendly CLI for Office 文档处理
- [Awesome-Prompts 角色扮演](https://github.com/dongshuyan/Awesome-Prompts/tree/master/%E8%A7%92%E8%89%B2%E6%89%AE%E6%BC%94) — 精选角色扮演 Prompt 合集
- [LINUX DO](https://linux.do) — 新一代开源技术社区

## License

MIT
