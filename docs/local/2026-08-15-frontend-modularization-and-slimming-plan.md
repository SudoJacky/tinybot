# Tinybot 前端模块化与瘦身计划

- 日期：2026-08-15
- 状态：实施中；低风险瘦身、TinyOS/Memory/Settings/Tools 加载 seam、首批路由 CSS、Shell route surface、Workspace adapter 与 TinyOS 循环清理已完成
- 基线提交：`c18d0bae refactor: extract chat context usage`
- 范围：`src/react-workbench`、被桌面前端直接使用的 `src/app-core`、前端依赖和分析工具
- 本地约束：本文位于被忽略的 `docs/local/`，只作为本地实施依据，不推送到 GitHub

## 1. 结论

当前前端可以稳定通过类型检查、测试和构建，首包也已通过 ECharts 延迟加载获得明显下降。下一阶段不应继续零散地从大文件中搬函数，而应按以下顺序推进：

1. 清理无引用依赖和经真实调用关系确认的休眠代码；
2. 建立 TinyOS、非首屏路由和样式的加载 seam，继续降低启动成本；
3. 先消除 `tinyOsKernelModel` 的循环依赖，再拆分高扇入的 Chat 类型与投影实现；
4. 将 `ChatPage` 收敛为页面编排模块，把会话运行、提交准备和时间线展示放到各自的深模块；
5. 将 `TinyOsShell` 收敛为桌面编排模块，把窗口、浏览器、终端和文件应用拆到真实职责 seam；
6. 收窄设置模型的外部 interface，并把 `defaultServices` 保持为单一 composition root；
7. 在上述职责 seam 上拆分 CSS 和测试，最后清零现存静态分析债务。

`defaultServices.ts` 虽然大，但它现在对外只暴露 `createDesktopAppServices()`，外部 interface 已经较深。因此它不是简单按行数拆文件的第一优先级；实施时应保留这个小 interface，只把内部 adapter 和归一化实现移到其所属模块。

### 1.1 实施进度

2026-08-15 已完成第一批清理：

- 删除 17 个确认不连接生产入口的迁移遗留模块；
- 删除 16 个只验证这些休眠实现的测试文件，共移除 54 个休眠行为测试；
- 保留 `timelineFromReactMessages`，并将其移动到 `chat/test/`，使分析器正确识别为测试 helper；
- 生产文件从 119 降至 101，生产代码从 36,125 行降至 33,717 行，分支点从 6,399 降至 6,006；
- 不可达候选从 18 降至 0，ESLint finding 从 48 降至 47；
- 完整分析通过：80 个 Vitest 文件、552 个测试、TypeScript、ESLint、源码分析、生产构建和 bundle 分析全部成功；
- 构建产物保持不变，证明删除内容此前没有进入生产 bundle。
- 移除 8 个没有前端调用的 npm 直接依赖，直接依赖从 22 个降至 14 个，lockfile package 记录从 591 降至 563；
- npm 实际移除 28 个包；`clsx` 仍作为传递依赖存在，但 Tinybot 不再直接声明；
- 保留 Rust `tauri-plugin-notification`、bootstrap 注册和 capability，只移除未使用的前端 JS bindings；
- 依赖清理后的完整前端分析再次通过，生产 bundle 保持不变。
- 建立统一的 `DeferredSurface` 加载模块，集中处理 loading、失败原因、诊断日志与显式重试；
- `LiveCanvas` 改为首次打开时加载 `TinyOsShell`，TinyOS 独立为约 76.52 KiB gzip 的异步 chunk；
- Settings 与 Memory 从 `DesktopShell` 的启动图中移出，分别形成约 14.94 KiB 与 1.59 KiB gzip 的异步 chunk；
- 删除 Chat 空状态唯一使用的 `TextType`、其 GSAP 运行时链路和只验证该孤儿实现的测试与样式；
- 将共享 TinyOS contracts 下沉到 `tinyOsKernelContracts.ts`，生产 import cycle 从 1 降至 0；
- 初始 JavaScript gzip 从 541,240 B 降至 452,901 B，下降 16.32%；初始资源总 gzip 从 579,250 B 降至 490,845 B，下降 15.26%；
- JavaScript 总 gzip 为 2,527,641 B，相比上一阶段只增长约 0.20%，没有因拆分产生异常重复；
- 完整分析再次通过：80 个测试文件、553 个测试、TypeScript、ESLint、源码分析、构建与 bundle 门禁全部成功；
- 真实浏览器验证 Chat 首屏、Settings 首次加载和 TinyOS 首次打开均成功，未出现动态模块加载错误。
- 将 Tools 与插件页从 `DesktopShell` 提取为 `ToolsRoute`，外部 interface 只保留 `services` 与 `onOpenChat`，并通过 `DeferredSurface` 按需加载；
- 将 Tools 独占的 650 余行样式移动到 route-scoped `ToolsRoute.css`，形成约 13.02 KiB raw / 2.52 KiB gzip 的异步 CSS chunk；
- `DesktopShell.tsx` 从上一阶段约 1,229 行降至 802 行，`workbench.css` 从 12,947 行降至 12,291 行；
- 修复工具目录加载失败被空集合掩盖的问题：失败状态现在显示原始错误、提供重试，并记录 `[tinybot-tools-route]` 诊断；
- 初始 JavaScript gzip 从 452,901 B 继续降至 449,525 B，初始 CSS gzip 从 36,964 B 降至 35,391 B，初始资源总 gzip 从 490,845 B 降至 485,896 B；
- JavaScript 总 gzip 为 2,528,804 B，相比最初基线只增长 0.18%，新增 route chunk 未造成异常重复；
- ESLint finding 从 47 降至 45；完整分析通过 81 个测试文件、554 个测试、类型检查、源码分析、构建与 bundle 门禁；
- 真实浏览器确认 Tools 代码与 CSS 只在首次进入路由后请求，专属样式已应用；无 Tauri 环境会显示工具目录错误与重试按钮，而不是伪装为空目录。
- 将 Chat/Files/Memory/Tools/Settings 的路由选择和延迟加载统一收进 `RouteSurface`，`DesktopShell` 只向它提供当前路由、服务、导航和成组的 Chat route context；
- `DesktopShell.tsx` 从 802 行降至 654 行，达到 Phase 7 的低于 700 行目标，没有引入 pass-through wrapper 或 compatibility re-export；
- 删除会吞掉 Files 加载错误的通用 `useAsyncList`：Files 现在区分 loading/ready/failed，失败时保留原始 cause、记录 `[tinybot-files-route]` 与 attempt，并提供显式重试；
- ESLint finding 从 45 降至 43；完整分析通过 82 个测试文件、555 个测试、类型检查、源码分析、构建与 bundle 门禁；
- 初始 JavaScript gzip 从 449,525 B 降至 449,034 B，初始资源总 gzip 从 485,896 B 降至 485,402 B，拆分未引入启动体积回退；
- 真实浏览器验证 Files 失败文案和重试路径：无 Tauri 环境显示原始错误，第二次请求记录 `attempt: 2`，不会伪装为空目录。
- 从 `defaultServices.ts` 提取 `createDesktopWorkspaceStore()`：调用方只提供初始化动作和 native workspace adapter，文件列表、目录页、文件 chunk、路径格式与结构化查询错误均收进模块内部；
- `defaultServices.ts` 从 1,325 行降至 1,204 行，`createDesktopAppServices()` 和 `AppServices.workspaceStore` interface 保持不变；
- 新增 WorkspaceStore interface 测试，覆盖文件摘要、目录/文件结果归一化及 `code/path/retryable` 错误语义；
- 完整分析在并发运行时暴露 Agent UI 表单 draft 竞态：首次挂载后的冗余 effect 或相同表单对象重新投影会覆盖刚输入的值；
- 表单 draft 现在仅在 `form_id + updated_at` canonical revision 变化时重置，同 revision 重投影保留本地编辑，新 revision 仍接收后端值；
- 完整分析通过 84 个测试文件、560 个测试、类型检查、源码分析、构建与 bundle 门禁；ESLint finding 保持 43，生产循环保持 0。

Settings/TinyOS 剩余路由级 CSS、Chat/Settings 模块深化、Tools/Settings/native event adapters 与静态分析债务仍待后续阶段实施。

## 2. 调查基线

调查依据为 `tools/frontend-analysis/reports/latest` 在 2026-08-15 生成的完整报告，以及当前源码的 import、符号引用和测试调用关系。

### 2.1 总体指标

| 指标 | 当前值 | 判断 |
|---|---:|---|
| 生产 TypeScript/TSX 文件 | 119 | 规模已需要稳定模块 seam |
| 生产代码行数 | 36,125 | 前十个大文件占 48.8% |
| 生产分支点 | 6,399 | 前十个大文件占 56.1% |
| ESLint findings | 48 | 主要集中在 Hook 依赖与调用规则 |
| 生产 import cycle | 1 | 必须先消除，不能用 re-export 掩盖 |
| 不可达候选 | 18 | 仅为调查入口，不是直接删除授权 |
| 初始资源 gzip | 579,250 B | 比原基线低 24.42%，仍有大入口告警 |
| 初始 JavaScript gzip | 541,240 B | 主要仍集中在单个入口 chunk |
| 初始 CSS gzip | 37,034 B | 所有页面样式仍由一个全局入口加载 |
| JavaScript 总 gzip | 2,522,623 B | 语言包和按需 chunk 占较大部分 |
| 测试 | 96 files / 606 tests | 当前全部通过 |

### 2.2 复杂度热点

| 文件 | 行数 | 分支点 | fan-out | 当前主要职责 |
|---|---:|---:|---:|---|
| `chat/ChatPage.tsx` | 4,630 | 983 | 37 | 会话、事件订阅、队列、Composer、Timeline、TinyOS 协调 |
| `chat/TinyOsShell.tsx` | 2,794 | 666 | 17 | 桌面窗口、overlay、文件、终端、浏览器和动画 |
| `app-core/settings/desktopSettingsProviders.ts` | 2,234 | 381 | 0 | contracts、draft、校验、patch、pane 投影、保存回写 |
| `shell/DesktopShell.tsx` | 1,385 | 135 | 20 | 窗口框架、菜单、路由、Tools、Settings |
| `app-core/chat/chatTurnModel.ts` | 1,382 | 409 | 2 | contracts、payload 校验、timeline 投影、脱敏和 artifact |
| `react-workbench/defaultServices.ts` | 1,326 | 360 | 25 | composition root、native event bridge、所有 store adapter |
| `components/ui/claude-style-ai-input.tsx` | 1,088 | 166 | 2 | Composer 交互与展示 |
| `app-core/chat/tinyOsKernelModel.ts` | 1,014 | 231 | 2 | TinyOS contracts 与 kernel 投影 |
| `settings/ProviderModelsSettingsPage.tsx` | 962 | 139 | 5 | provider 页面状态与表单 |
| `app-core/chat/tinyOsCommand.ts` | 830 | 122 | 2 | TinyOS command contracts 与构造 |

行数只用于提示调查范围，不作为拆分成功的唯一标准。拆分后的模块必须拥有更小、稳定且可通过 observable outcome 测试的 interface。

### 2.3 样式热点

`src/react-workbench/styles/workbench.css` 当前为 12,947 行、约 308 KB 源码。构建后主 CSS 为约 253 KB raw / 37 KB gzip。它同时包含 shell、chat、session、settings、TinyOS 和响应式规则，其中 `tinyos` 前缀出现约 694 次，`react-session` 约 216 次，`react-settings` 约 130 次。

问题不只是文件太长，而是 `main.tsx` 无条件导入整个样式表，使尚未访问的 Settings 和尚未打开的 TinyOS 也进入启动 CSS。

### 2.4 启动依赖热点

当前已经完成的有效加载 seam：

- `DataViewCard` 延迟加载 `DataViewChart`；
- ECharts 已成为独立约 185 KB gzip 的异步 chunk；
- `tinyOsHighlight.worker` 已成为独立 worker chunk。

仍在启动路径上的已确认问题：

- `LiveCanvas.tsx` 静态导入 `TinyOsShell.tsx`；
- `TinyOsShell.tsx` 静态导入 GSAP、`TinyOsSideRays` 和多种 TinyOS 应用实现；
- `ChatPage.tsx` 只为首屏一行提示文字导入 `TextType.tsx`，后者静态导入 GSAP；
- `DesktopShell.tsx` 静态导入 Chat、Memory、全部 Settings 页面和 Tools 页面；
- `AssistantMarkdown.tsx` 静态导入 Streamdown、CJK 与 code plugin，是否继续延迟必须先做首条回答体验和 treemap 测量。

### 2.5 循环依赖

唯一生产循环为：

```text
tinyOsKernelModel.ts
  -> tinyOsNativeSnapshot.ts
  -> tinyOsKernelModel.ts
```

`tinyOsNativeSnapshot.ts` 只需要 kernel 中的 `TinyOsProcessState`、`TinyOsProvenance` 和 `TinyOsResourceAccess`。这些共享 contracts 应向依赖根移动到 `tinyOsKernelContracts.ts`，而不是增加 barrel re-export。

### 2.6 ESLint 债务分布

48 个 finding 中：

- `react-hooks/exhaustive-deps`：21；
- `react-hooks/rules-of-hooks`：16；
- 其余为 `no-redeclare`、`preserve-caught-error`、`no-control-regex`、`no-useless-escape`、`no-extra-boolean-cast` 和 `no-unreachable`。

文件分布主要为：

- `TinyOsFilesExplorer.tsx`：17；
- `ChatPage.tsx`：9；
- `TinyOsShell.tsx`：7；
- `DesktopShell.tsx`：4。

这些 finding 应在相应模块重构时修复根因，不允许用 ESLint disable、空依赖数组或隐藏 fallback 压掉。

## 3. 清理候选的真实分类

### 3.1 未被源码 import 的直接依赖

以下直接依赖在 `src/**/*.ts(x)` 中没有真实 import：

- `3d-force-graph`
- `clsx`
- `graphology`
- `marked`
- `openai`
- `sigma`
- `three`

它们当前在 `node_modules` 的直接包目录合计约 62.47 MiB。该数字是本机安装目录的提示值，不等同于最终 lockfile 或安装体积下降量。

`@tauri-apps/plugin-notification` 也没有 TypeScript import，但必须同时检查 Tauri plugin 注册、capability 和 Rust 依赖后再决定，不能只根据前端 import 删除。

实施动作：

1. 全仓排除 `node_modules`、构建产物和报告后再次检索；
2. 核对 `src-tauri` plugin 注册与 capability；
3. 使用包管理命令移除已确认依赖并更新 `package-lock.json`；
4. 同步移除分析配置中已不存在的 heavy dependency 名称；
5. 运行 `npm ls`、完整测试、构建和 bundle 对比。

### 3.2 仅由测试引用的独立生产模块

以下模块不在 `src/main.ts` 的生产可达图中，符号引用也只来自测试或测试型校验模块：

- `app-core/agent-ui/desktopTsAgentFormActions.ts`
- `app-core/chat/chatBranchSession.ts`
- `app-core/chat/chatDetailPanelState.ts`
- `app-core/chat/chatSubagentForward.ts`
- `app-core/chat/chatSubagentTranscript.ts`
- `app-core/native/desktopNativeAppContracts.ts`
- `app-core/native/desktopNativeSkills.ts`
- `app-core/settings/desktopSettingsConceptOwners.ts`
- `app-core/settings/desktopSettingsLocalPreferences.ts`
- `app-core/settings/desktopSettingsSchemaCoverage.ts`
- `app-core/tools-skills/desktopToolsSkills.ts`
- `app-core/workspace/desktopFileExport.ts`

这些模块是优先删除候选，但仍要先确认它们不是下一阶段已经批准、只是尚未接线的能力。确认删除时，源文件和只验证该休眠实现的测试必须同一提交删除，不能留下“测试通过但产品永远不调用”的假能力。

### 3.3 整体不可达的任务通知集群

以下模块之间存在内部引用，但整个集群不连接生产入口：

```text
desktopNativeUx
  -> desktopTaskCenter
       -> desktopTaskCenterSources
       -> desktopTaskNotifications
            -> desktopOsNotifications
```

这里必须二选一：

- 如果 Task Center 已取消，则按整个集群删除源码、测试、文案和残留依赖；
- 如果仍在近期范围，则先定义真实入口和产品验收，不允许为了降低不可达数量而建立空接线。

### 3.4 不应删除的误报

`chat/testTimelineFixtures.ts` 被 `ChatPage.test.tsx` 和 `DesktopShell.test.tsx` 使用，它是测试 helper，不是死代码。应将其移动到明确的 test 目录或改为分析器可识别的命名，并给分析器补测试，避免继续计入生产不可达候选。

18 个不可达候选合计约 2,408 行、393 个分支点，但这个数字不能直接当作可删除代码量。

## 4. 目标模块图

```text
App
└─ DesktopShell                    # window/menu/navigation only
   └─ RouteSurface                 # lazy route selection
      ├─ ChatPage                  # page composition only
      │  ├─ useChatSessionRuntime  # load/subscribe/revision/error
      │  ├─ ChatSessionWorkspace   # session/project/tab navigation
      │  ├─ ChatComposer           # draft/reference/submit interface
      │  ├─ ChatTimeline           # canonical turn projection and rendering
      │  └─ LiveCanvas
      │     └─ lazy TinyOsShell    # loaded only when canvas is present
      │        ├─ TinyOsWindowManager
      │        ├─ TinyOsFilesApp
      │        ├─ TinyOsTerminalApp
      │        └─ TinyOsBrowserApp
      ├─ MemoryRoute
      ├─ ToolsRoute
      └─ SettingsRoute

createDesktopAppServices           # single external interface remains
├─ native event bridge
├─ chat/session adapters
├─ settings adapter
├─ tools/plugin adapter
└─ workspace/memory adapters
```

模块设计规则：

- 每个模块只有一个面向调用方和测试的 interface；
- 纯计算优先接收输入并返回结果，不创建依赖、不修改外部状态；
- 页面模块只编排 state 和子模块，不再包含协议归一化；
- native adapter 的错误保留原始 `cause` 和可追踪标识；
- 测试通过模块 interface 验证 observable outcome，不穿透到私有 helper；
- 新 interface 只在确实有多个调用方或生产/测试 adapter 时建立，不为假想扩展制造抽象。

## 5. 分阶段实施计划

### Phase 0：校准分析口径

目标：保证后续数字真实反映生产代码，而不是测试 helper 或报告误差。

工作项：

1. 将 `testTimelineFixtures.ts` 移入明确测试位置或改为测试命名；
2. 给 source analyzer 增加 fixture 分类用例；
3. 在报告中增加按模块前缀汇总的 lines、branch points、fan-in/fan-out；
4. 记录每阶段的 initial JS/CSS gzip、总 JS gzip、cycle 和 ESLint finding；
5. 不覆盖原始基线，用独立阶段快照做前后对比。

退出条件：报告不再把测试 fixture 列为生产死代码，且同一 commit 连续运行得到稳定结果。

### Phase 1：低风险瘦身

目标：先删除不产生产品价值的安装和维护成本。

工作项：

1. 移除确认无引用的直接依赖；
2. 对 12 个测试独占模块逐项做产品范围确认；
3. 对 Task Center 集群做“完整接线或整体删除”决策；
4. 删除时同步删除失去意义的测试、i18n key 和分析配置；
5. 每个清理提交后运行全量分析，禁止批量删除后再猜是哪项破坏了行为。

退出条件：

- `npm ls` 无 invalid/extraneous；
- 生产入口行为和 606 个现有测试基线不退化；
- 不可达列表只剩经明确保留的模块；
- lockfile 和安装目录下降有实际记录。

### Phase 2：建立真实加载 seam

目标：未打开的 TinyOS 和未访问的路由不进入启动 JavaScript/CSS。

工作项：

1. 在 `LiveCanvas.tsx` 中延迟加载 `TinyOsShell`，只保留类型级静态 import；
2. 为 TinyOS loading/error 状态提供可访问的明确反馈，加载失败不能静默回退；
3. 移除 Chat 空状态对 `TextType` 的单点依赖，优先使用无运行时依赖的 CSS/React 实现；
4. 确认 TinyOS 延迟后 GSAP 和 OGL 不再位于 initial graph；
5. 将 Memory、Tools、Settings 的 route surface 从 `DesktopShell.tsx` 提取并延迟加载；
6. 将 Settings 和 TinyOS 样式由各自 lazy 模块导入，使 Vite 生成对应 CSS chunk；
7. 对 Streamdown 先做 treemap和首条回答 profile；只有证明收益后才延迟 code/CJK plugin，不能让常用回答出现不稳定闪烁。

退出条件：

- 初始 JavaScript gzip 至少再下降 15%，目标不高于约 460 KiB；
- 初始资源总 gzip 目标不高于 500 KiB；
- 初始 CSS gzip 目标不高于 30 KiB；
- 打开 TinyOS、Settings 和首次 Markdown 的交互均有浏览器实测；
- 总 JavaScript gzip 不因重复 chunk 增长超过 2%。

### Phase 3：消除循环并收窄 Chat contracts

目标：先修依赖方向，再移动高扇入模型，避免拆出新的循环。

工作项：

1. 新建 `app-core/chat/tinyOsKernelContracts.ts`，只容纳 snapshot 与 kernel 共同需要的 contracts；
2. 让 `tinyOsNativeSnapshot.ts` 和 `tinyOsKernelModel.ts` 单向依赖该 contracts 模块；
3. 将 `chatTurnModel.ts` 分为三类实现：
   - 稳定的 turn/item contracts；
   - backend payload 校验与规范化；
   - backend timeline 到 UI turn 的投影与安全预览；
4. 为投影提供单一 interface，例如 `projectBackendTimeline(input)`，内部 helper 不导出；
5. 迁移调用方到准确模块，临时 compatibility re-export 只允许在同一阶段内存在，阶段结束前删除。

退出条件：

- 生产 cycle 从 1 降为 0；
- contracts import 不带入运行时投影代码；
- 旧 `chatTurnModel` 测试由新 interface 测试替代，而不是重复保留两套；
- timeline snapshot、patch、redaction 和 artifact 行为与当前基线一致。

### Phase 4：深化 Chat 模块

目标：让 `ChatPage` 只负责页面级组合，不再同时实现状态机、协议转换和全部子视图。

#### 4.1 会话运行模块

将当前 timeline load、subscribe、revision batching、forms、browser snapshot 和错误状态收进 `useChatSessionRuntime`：

```ts
useChatSessionRuntime({ sessionId, chatStore })
  -> { state, actions }
```

`state` 必须显式表示 `loading | ready | failed`，`actions` 只暴露 reload 和运行控制等真实能力。revision gap 和加载错误应 fail fast，并保留 session/turn/revision 诊断信息。

#### 4.2 Composer 提交模块

将 session transcript 截断、TinyOS/file reference 转换、模型选择和 queued input 准备放入纯模块：

```ts
prepareChatSubmission(input) -> PreparedChatSubmission
```

字节预算、引用上限和中段省略规则由模块内部拥有，调用方不再了解 UTF-8 截断细节。

#### 4.3 Canonical Timeline 模块

把当前约 1,250 行的 `CanonicalChatTurn`、Execution、Plan、Message、Error、Tool、Artifact 和 Subagent 展示收敛到 `ChatTimeline`。外部只传 canonical turns、必要 view state 和一个 actions 对象；分组、状态文案、错误详情和 artifact 去重留在内部。

#### 4.4 Session workspace 模块

将 session sidebar、project group、tabs、search 和 workspace picker 收进 `ChatSessionWorkspace`，避免 ChatPage 直接维护所有菜单与弹窗状态。

退出条件：

- `ChatPage.tsx` 目标低于 1,800 行、`useEffect` 不超过 12 个、fan-out 不超过 20；
- 这些数字只作 guardrail，任何为了达标而制造 pass-through 模块的拆分必须撤销；
- `ChatPage.test.tsx` 的 121 个测试按新 interface 迁移，页面集成测试只保留关键用户流程；
- 切换会话、流式 patch、队列、恢复、TinyOS 打开和 reload 行为均通过测试。

### Phase 5：深化 TinyOS 模块

目标：`TinyOsShell` 只负责桌面级编排，具体应用各自拥有状态和副作用。

工作项：

1. `useTinyOsWindowManager`：窗口 rect、focus、z-order、overview、switcher 和持久化；
2. `TinyOsBrowserApp`：地址、tab、native surface scheduling、handoff 和错误；
3. `TinyOsTerminalApp`：命令输入、执行生命周期、follow/search 和输出；
4. `TinyOsFilesApp`：selection、编辑/保存/移动/删除和 Agent request；
5. `TinyOsOverlays`：palette、context menu、notifications、system dialog；
6. presentation helper 只保留纯格式化与 projection，不读取 DOM 或全局状态；
7. 修复 `TinyOsFilesExplorer`、`TinyOsShell` 的 Hook finding 根因，不能通过 disable 规避。

退出条件：

- `TinyOsShell.tsx` 目标低于 1,200 行；
- browser native surface 的 layout revision、visibility 和错误可通过模块 interface 独立测试；
- files/terminal/browser 任一应用的修改不要求重跑另一应用的私有测试；
- TinyOS 相关 `rules-of-hooks` 和 `exhaustive-deps` finding 清零；
- reduced-motion、键盘操作和窗口恢复经过真实浏览器验证。

### Phase 6：收窄 Settings 模型

目标：把当前 2,234 行、多个公开函数的浅 interface 收敛为 draft 生命周期。

目标 interface：

```ts
createDesktopSettingsDraft(snapshot, providerCatalog) -> DesktopSettingsDraft
editDesktopSettingsDraft(draft, action) -> DesktopSettingsDraft
prepareDesktopSettingsSave(draft, existingConfig) -> SaveRequest
reconcileDesktopSettingsSave(draft, result) -> DesktopSettingsDraft
```

内部实现分为 contracts、metadata registry、draft reducer、persistence patch 和 pane projection；调用方不直接组合 touched path、secret mask、provider editor 和 save status。

同时将 `ProviderModelsSettingsPage` 的加载/保存状态与表单展示分开，但不建立只有一个 adapter 的假 port。

退出条件：

- 设置调用方不再分别了解 patch、mask、origin、dirty 和 reconcile 细节；
- 最大设置实现文件目标低于 900 行；
- secret、provider default、auto/manual commit、workspace reload 和 validation 行为均通过 draft interface 测试；
- Settings 页保存失败保留原始错误原因和可见状态。

### Phase 7：整理 Shell 与服务 composition root

目标：缩小高 fan-out 文件，同时保持真正有价值的小外部 interface。

工作项：

1. `DesktopShell` 只保留 window frame、menu、navigation 和 provider 组合；
2. Tools、Settings 和 route page 移入独立 route 模块；
3. `defaultServices.ts` 继续只导出 `createDesktopAppServices()`；
4. 将 native event bridge、chat/session、settings、tools/plugin、workspace/memory adapter 移到内部实现文件；
5. normalization 放回拥有相应数据语义的模块，不建立通用 `utils.ts`；
6. native event 和 adapter 错误携带 event/session/operation 标识，`catch` 不得只返回空集合。

退出条件：

- `DesktopShell.tsx` 目标低于 700 行；
- `defaultServices.ts` composition root 目标低于 400 行；
- `createDesktopAppServices()` 和 `AppServices` 保持稳定，调用方无需了解 native adapter 细节；
- event listener 注册/清理、分页不前进、timeline error 和 host operation 均有可观察测试。

### Phase 8：样式与测试收口

目标：让样式和测试跟随真实模块，而不是继续形成第二个单体。

推荐样式 seam：

```text
styles/base.css                 # tokens, reset, typography, accessibility
shell/DesktopShell.css         # always-loaded shell
chat/ChatPage.css               # chat composition
chat/ChatTimeline.css           # canonical timeline
chat/LiveCanvas.css             # canvas frame
chat/TinyOsShell.css            # lazy TinyOS applications
settings/SettingsRoute.css      # lazy settings route
```

不能仅在 `workbench.css` 中使用 `@import` 把所有文件重新汇总到启动入口；route/TinyOS CSS 必须由对应 lazy TypeScript 模块导入，才能形成真正的加载 seam。

测试调整：

- 删除依赖整个 CSS 文件文本和私有源码字符串的脆弱断言；
- 关键视觉 contract 用可访问语义、computed style 或浏览器截图验证；
- 老浅模块测试在新 interface 测试覆盖后删除，不能叠加两套维护成本；
- 完成现存 48 个 ESLint finding 的根因修复，基线最终归零。

退出条件：

- 没有单个样式文件超过约 2,500 行；
- initial CSS 达到 Phase 2 预算且无重复规则异常增长；
- ESLint findings 为 0，不新增 disable；
- 全量测试、构建、bundle 和桌面关键流程验证通过。

## 6. 推荐提交顺序

每个阶段保持可独立回滚，推荐拆成以下提交：

1. `chore: classify frontend test fixtures`
2. `chore: remove unused frontend dependencies`
3. `refactor: remove dormant frontend modules`
4. `perf: lazy load optional desktop surfaces`
5. `perf: split route scoped frontend styles`
6. `refactor: remove tinyos model cycle`
7. `refactor: split chat timeline contracts`
8. `refactor: extract chat session runtime`
9. `refactor: extract chat submission model`
10. `refactor: extract canonical chat timeline`
11. `refactor: modularize tinyos applications`
12. `refactor: deepen desktop settings model`
13. `refactor: split desktop service adapters`
14. `refactor: modularize workbench styles`
15. `fix: clear frontend static analysis debt`

若某个加载提交未改善其目标 bundle 指标，停止继续叠加 manual chunk 或缓存技巧，回到 treemap 和运行 trace 重新诊断。

## 7. 总体验收预算

| 维度 | 当前 | 完成目标 |
|---|---:|---:|
| 生产 import cycles | 1 | 0 |
| ESLint findings | 48 | 0 |
| 不可达候选 | 18 | 0 个误报；保留项有明确入口或测试分类 |
| 初始 JavaScript gzip | 541,240 B | 不高于约 460 KiB，争取 450 KiB |
| 初始资源总 gzip | 579,250 B | 不高于 500 KiB |
| 初始 CSS gzip | 37,034 B | 不高于 30 KiB |
| JavaScript 总 gzip | 2,522,623 B | 不增长超过 2%，删除依赖后应下降 |
| `ChatPage.tsx` | 4,630 lines | 小于 1,800 lines，保持页面编排职责 |
| `TinyOsShell.tsx` | 2,794 lines | 小于 1,200 lines，保持桌面编排职责 |
| `DesktopShell.tsx` | 1,385 lines | 小于 700 lines |
| 最大设置实现 | 2,234 lines | 小于 900 lines |
| `workbench.css` | 12,947 lines | 删除单体入口，单文件小于约 2,500 lines |

行数目标是防止职责重新聚集的 guardrail，不允许为了达到数字创建 pass-through module、barrel 循环或重复 contracts。

## 8. 每阶段验证流程

每个实现提交至少执行：

```text
npm run typecheck
npm test
npm run analyze:frontend
git diff --check
```

涉及加载和样式时额外执行：

1. 对比 `baseline-comparison.json` 和 bundle treemap；
2. 冷启动验证 Chat 首屏；
3. 首次打开 TinyOS、Settings、Tools；
4. 首次渲染普通 Markdown、代码块和 Data View；
5. 390px 移动宽度、桌面宽度、reduced-motion 和键盘路径；
6. 检查浏览器控制台和 renderer diagnostics，没有静默加载错误。

涉及状态模块时额外验证：

- live 与 reload projection 等价；
- session 切换不会泄漏 listener、timer 或 animation frame；
- revision gap、native invoke 失败和动态 import 失败可观察；
- 错误不会被空数组、旧 snapshot 或默认成功状态吞掉。

## 9. 风险与决策

### 9.1 不把不可达报告当删除命令

动态入口、Tauri callback、worker 和测试 fixture 可能不在普通 import 图中。删除前必须同时检查符号引用、native 注册、产品范围和运行验证。

### 9.2 不用 barrel 隐藏循环

`index.ts` re-export 可能让 import 看起来整洁，但不会改变依赖方向。共享 contracts 必须移动到真正的依赖根。

### 9.3 不以 Suspense 闪烁换 bundle 数字

Chat 是默认路由，常用 Composer 和普通回答不能为了极限首包而变成多次闪烁。TinyOS、Settings、Tools 是明确的延迟加载对象；Streamdown 需要 profile 后再决定。

### 9.4 不复制状态 authority

拆 hooks 时不得把 timeline、queue、browser snapshot 或 settings draft 复制为多份 state。每类状态只能有一个 owner，其余模块读取 projection 或发送 action。

### 9.5 不保留永久 compatibility 层

迁移期 re-export 和 wrapper 必须在同一阶段删除。新旧入口长期并存会抵消模块化收益并重新制造不可达代码。

## 10. Definition of done

本计划完成需要同时满足：

- Chat、TinyOS、Settings、Shell 和 native adapters 都有清晰且较小的 interface；
- 页面模块不再拥有协议归一化、持久化 patch 或 native payload 细节；
- 生产 import graph 无循环，测试 helper 不污染生产不可达报告；
- 已确认休眠代码和无引用依赖被删除，没有靠空接线伪造可达；
- TinyOS 与非首屏 route 形成真实 JavaScript/CSS 加载 seam；
- 初始 bundle 达到预算，总 bundle 不因重复 chunk 失控；
- 现存 ESLint 债务归零，错误路径保留 cause 和诊断上下文；
- 模块测试通过公开 interface，页面集成测试覆盖关键用户流程；
- 96/606 的当前行为基线被等价或更强的新测试替代；
- 完整前端分析、浏览器关键流程和生产构建全部通过。
