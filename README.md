# WorkBuddy for Copilot Chat (copilot-buddy)

把已登录的 **WorkBuddy / WorkBuddy AI** 桌面 App 里的模型接进 **VS Code Copilot Chat**，复用 App 的账号登录与积分，零配置。

> 实现方式移植自 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT，DSH 插件），协议参照 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）。本项目与腾讯、WorkBuddy、微软均无关联。

## 前置条件

- VS Code **1.104+**，已安装 GitHub Copilot Chat 扩展并启用聊天视图
- 本机已安装并登录 **WorkBuddy**（国内版）或 **WorkBuddy AI**（国际版）桌面 App
- 注意：Copilot Business / Enterprise 用户需要管理员在 GitHub 的 Copilot 策略设置中启用 **Bring Your Own Language Model Key**；个人版（Free / Pro / Pro+）默认可用

## 安装

```sh
code --install-extension copilot-buddy-0.1.0.vsix
```

或手动：命令面板 → `Extensions: Install from VSIX…`。装完重载窗口。

**验证**：Copilot Chat 输入框的模型选择器中出现 **WorkBuddy** / **WorkBuddy AI** 分组；只装/只登录一版就只出现一组。从分组里选一个模型完成一次对话，即安装成功。

## 功能

- **零配置**：直接复用桌面 App 的登录文件（`CodeBuddyExtension` 共享认证目录），账号切换自动跟随，绝不写入 App 自己的文件
- **静态加密解密**：WorkBuddy 5.6+ 的登录文件对令牌做了 AES-256-GCM 静态加密；本扩展以 `ELECTRON_RUN_AS_NODE` 模式运行 App 自带的可执行文件一次，取回 App 私有的静态密钥完成解密（密钥仅存内存）
- **双变体并存**：国内版「WorkBuddy」与国际版「WorkBuddy AI」各自独立分组、独立凭据、独立积分，互不混用；登录域名校验防止两版凭据误用
- **流式对话**：OpenAI 兼容协议 + SSE 流式，文本增量实时显示
- **工具调用**：声明 tool calling 能力，模型可出现在 Copilot Chat 的 Agent 模式里（上游对全目录 speaks OpenAI tools 协议）
- **图片输入**：上游声明支持图片的模型可直接在对话中附加图片
- **模型元数据**：模型名后直接显示 WorkBuddy 积分倍率（`GLM-5.3 · x0.79`、`Hy3 · x0.00`），促销徽章跟在后面（`Hy4 preview · x0.00 · 限时免费`）；悬停可见上下文窗口、输出上限与倍率明细
- **积分速览**：状态栏显示各已登录账号的剩余积分（含企业版无限额度 `∞`、套餐明细、7 天内到期提醒），点击刷新
- **管理面板**：每个分组有独立的管理命令（状态 / 刷新 / 移除扩展自留凭据副本 / 复制诊断信息）

## 使用

1. 装好扩展并重载后，模型选择器（Copilot Chat 输入框下方的模型名 → 下拉）中会出现 WorkBuddy 分组
2. 选择模型直接对话；Agent 模式需要模型支持工具调用（已声明）
3. 状态栏 `⚡ WB·… AI·…` 显示剩余积分，点击刷新
4. 命令面板：
   - `WorkBuddy: Manage (Status, Credits, Sign-out)`
   - `WorkBuddy AI: Manage (Status, Credits, Sign-out)`

## 设置

默认无需任何设置。异常安装路径下可用：

| 设置 | 作用 |
|---|---|
| `workbuddy.authFile` | 国内版桌面 App 登录文件的完整路径（覆盖 `WORKBUDDY_AUTH_FILE` 环境变量） |
| `workbuddy.aiAuthFile` | 国际版桌面 App 登录文件的完整路径（覆盖 `WORKBUDDY_AI_AUTH_FILE`） |
| `workbuddy.electronBinary` | 国内版 App 可执行文件完整路径（覆盖 `WORKBUDDY_ELECTRON_BIN`） |
| `workbuddy.aiElectronBinary` | 国际版 App 可执行文件完整路径（覆盖 `WORKBUDDY_AI_ELECTRON_BIN`） |

改动设置后扩展自动重建，无需重载窗口。

## 工作原理

1. **凭据发现**：按平台探测桌面 App 的登录文件（Windows：`%LOCALAPPDATA%` 与 `%APPDATA%` 两个根；macOS：`~/Library/Application Support`；Linux：XDG 两基；WSL：优先挂载的 Windows 用户目录）
2. **解密**：5.6+ 的令牌字段是 `{$wbEncrypted:1, envelope}` 信封（AES-256-GCM，AAD 为 App 私有的 `WBEV1` 构造）；解密密钥 = sha256(App 私有 binding 返回的 `atRestSecretKey`)，通过运行 App 自己的二进制（`ELECTRON_RUN_AS_NODE=1` + `-e` 单行脚本调 `electron_browser_workbuddy_storage.loggerGet()`）获取。二进制定位顺序：显式配置 → 平台默认路径 → Windows 卸载注册表（含非 ASCII 输出的 PowerShell 5.1 UTF-8 兜底）→ macOS Spotlight
3. **令牌刷新**：到期前 5 分钟用 refresh token 自动续期，续期结果存扩展自留副本（globalStorage），桌面 App 文件只读不动；桌面文件是身份权威——账号切换后旧副本自动失效
4. **模型目录**：`/v3/config`（产品文档），国内版用 CLI 形态 UA、国际版用 App 形态 UA（`WorkBuddyAI/<v>`）；取 `cli` agent 名册 ∩ 可用行；拉取失败时降级到本账号上次成功目录（globalStorage 缓存）
5. **对话**：`/v2/chat/completions`（强制流式 + `developer→system` 角色改写 + `tool_choice` 字符串化 + 剥离 `off` 档位；国际版首条消息必须为 system，自动补位）
6. **积分**：个人版走 `get-user-resource`，国内企业账号走 `get-enterprise-user-usage`（周期额度）

## 已知限制

- **成本显示位置**：VS Code 的 `LanguageModelChatProvider` API（1.104–1.141）没有给扩展模型的计费字段——模型选择器里的 Copilot 官方模型成本来自 GitHub 服务端目录（`multiplier` / `priceCategory` / `tokenPrices`），扩展无法注入。因此 WorkBuddy 的积分倍率**写在模型名里**（`GLM-5.3 · x0.79`），这是模型选择器、Language Models 编辑器、选中模型标签都会渲染的位置；该倍率是 WorkBuddy 积分倍率，不是 Copilot premium request 倍率
- **推理档位**：v1 不提供档位选择，一律省略 `reasoning_effort`（即 WorkBuddy 默认档位）。VSCode 的 provider API 目前没有档位声明面
- **utility tasks**：标题生成 / 提交信息等后台任务默认用 Copilot 内置小模型；如需切换，设置 `chat.utilityModel` / `chat.utilitySmallModel` 为 WorkBuddy 模型
- **不覆盖补全**：BYOK 类模型不参与行内补全（inline suggestions）、语义搜索等依赖 GitHub 账号的功能
- **Windows + 国际版已在真机全链路验证**（解密 / 目录 / 积分 / 流式对话）；macOS / Linux / WSL / 国内版路径按 dsh-workbuddy-connect 已验证逻辑移植，未逐一实测
- **国内企业积分**：按官方 App 的接口契约实现，未在真实企业账号上实测
- **上游是私有接口**：WorkBuddy 更新后本扩展可能需要随之调整；目录接口失效时自动降级到已保存目录并在管理面板标注来源
- 桌面 App 从未登录时，对应分组不显示；登录文件的诊断信息（如 App 被卸载但残留登录文件）在管理命令中给出具体原因

## 开发

```sh
npm install        # 安装依赖（Node 22+）
npm run compile    # tsc 编译到 dist/
npm test           # 68 项自检（纯 Node，无 VS Code 依赖）
node dist/livetest.js [--chat]   # 真机验证（解密/目录/积分[/对话]，需本机已登录）
npm run package    # 打包 vsix
```

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担
- 本项目与腾讯、WorkBuddy、微软均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有

## 许可证

MIT — 见项目根目录的 `LICENSE` 文件。
