# 拓扑工作区全屏与导航图设计

## 状态

视觉方案已确认，等待 Spec 审阅与实施计划。

## 背景

React Flow 画布已用于靶场模板的创建和编辑。当前工具栏仍包含“选中自动布局”，但该操作价值有限；“切换专注模式”只是通过 CSS 隐藏资源工具轨和属性面板，不是浏览器的真实全屏。右下角 MiniMap 常驻且偏大，持续挤占可编辑区域。

本设计仅调整模板创建和编辑页中的 `TopologyFlowCanvas` 工作区，不改变实例详情页使用的只读 `TemplateCanvas`，也不改变拓扑数据、保存、检测、发布或云资源行为。

## 确认的体验决策

- 移除“选中自动布局”。保留“全部自动布局”。
- 将“切换专注模式”替换为“全屏编辑模式”。
- 全屏目标是拓扑工作区本身，不包含页面标题、全局导航或工作区外的属性面板。
- 右下角导航图默认隐藏；保留稳定、可发现的独立图标。
- 点击图标后，导航图在右下角图标上方展开，尺寸为 `120 × 80`；再次点击收起。
- 用户已在视觉稿中确认独立导航图开关方案。

## 非目标

- 不新增局部“选中自动布局”的替代功能。
- 不持久化导航图的显示状态；刷新或重新打开编辑器时保持默认隐藏。
- 不改变 React Flow 自带缩放、平移、连线、选择、撤销重做或资源工具轨行为。
- 不修改后端接口、拓扑 JSON 格式、草稿缓存格式或数据库。
- 不将整个浏览器窗口强制切换到应用外的展示模式。

## 组件与状态边界

### 移除选中布局链路

从 `TopologyFlowCanvasProps` 移除 `onLayoutSelection`，从 `TopologyFlowCanvasInner` 工具栏移除对应按钮。`TemplateEditorScreen` 同时移除只被该按钮调用的 `handleLayoutSelection` 与传参。

“全部自动布局”仍由既有 `onLayoutAll` 回调处理，进入现有撤销历史，不改变布局算法。

### 全屏编辑模式

`TopologyFlowCanvasInner` 为 `.topology-flow-workbench` 根 `section` 持有 `workbenchRef` 与 `isFullscreen` 状态：

1. 未全屏时点击“进入全屏编辑模式”，对根 `section` 调用 `requestFullscreen()`。
2. 已全屏时点击“退出全屏编辑模式”，调用 `document.exitFullscreen()`。
3. 监听 `fullscreenchange`，仅当 `document.fullscreenElement === workbenchRef.current` 时把 `isFullscreen` 置为真。
4. 浏览器按 `Esc` 退出全屏时，事件会把按钮图标、提示和 `aria-pressed` 同步回未全屏状态。
5. Fullscreen API 缺失或调用被浏览器拒绝时，不乐观更新 `isFullscreen`，画布继续正常编辑。

工具栏按钮使用 Lucide 的 `Maximize2` 与 `Minimize2`，并使用动态无障碍名称：

- 未全屏：`进入全屏编辑模式`
- 已全屏：`退出全屏编辑模式`

全屏状态以浏览器实际状态为唯一事实来源，不能再使用 `data-focus-mode` 或仅隐藏同级面板的 CSS 状态模拟。

### 默认隐藏的导航图

`TopologyFlowCanvasInner` 增加仅由本地 UI 控制的 `isMiniMapVisible`，初始为 `false`。右下角提供独立的图标按钮：

- 隐藏时：`aria-label` / `title` 为 `显示导航图`，`aria-pressed="false"`。
- 显示时：`aria-label` / `title` 为 `隐藏导航图`，`aria-pressed="true"`。

只有 `isMiniMapVisible` 为真时才渲染 React Flow `MiniMap`，保留 `pannable` 与 `zoomable`。MiniMap 增加专用 CSS class，并通过组件尺寸属性与 CSS 固定为 `120 × 80`。地图展开时位于开关按钮上方，避免遮挡图标；收起时不保留渲染成本与占位。

## 布局与样式

更新 `globals.css`：

- 删除依赖 `data-focus-mode` 的资源轨和属性面板隐藏规则。
- `.topology-flow-workbench:fullscreen` 进入浏览器全屏层，使用完整视口高度和宽度，移除圆角与外部边框，保持现有工具栏、资源工具轨、画布控制和属性选择能力。
- 为导航图开关提供与画布控制一致的 `32px` 稳定图标按钮、可见的 focus 样式和固定右下角位置。
- 以专用类约束 MiniMap 为 `120px × 80px`，并在打开时让其位于开关上方。
- 保持手机断点的属性面板避让规则；当导航图隐藏时，右下区域只留下图标开关。

## 异常与兼容

- Fullscreen API 在受限嵌入环境中可能被拒绝；此时按钮不会错误地显示为“退出全屏编辑模式”，编辑功能不受影响。
- `fullscreenchange` 可能由系统快捷键、`Esc` 或其他页面行为触发，组件必须在每次事件后基于 `document.fullscreenElement` 重算状态。
- 组件卸载时清理事件监听，不保留全屏状态的陈旧引用。
- MiniMap 的显示状态不参与草稿、历史或视口保存，因此不会污染拓扑数据。

## 测试策略

先以失败测试定义行为：

- 画布默认不渲染 MiniMap；点击“显示导航图”后渲染，重复点击后移除。
- “选中自动布局”按钮和 `onLayoutSelection` 调用链不再存在；“全部自动布局”仍可调用。
- 点击全屏按钮会请求根工作区全屏；`fullscreenchange` 发生后，按钮名称、图标状态与 `aria-pressed` 反映真实状态。
- 外部退出全屏的 `fullscreenchange` 会恢复“进入全屏编辑模式”状态。
- 样式契约测试确认使用 `:fullscreen`，不再引用 `data-focus-mode`，并约束导航图为 `120px × 80px`。
- 继续运行模板编辑器与拓扑画布现有回归测试，确保画布交互、资源放置、缓存、连线和视口恢复不回归。

## 容器验证

实现完成后：

1. 在 Docker 容器中执行拓扑画布与模板编辑器 Vitest 回归。
2. 使用 Docker Compose 重建 Web 镜像并强制重建 Web 容器。
3. 通过已登录浏览器打开模板创建或编辑页，确认工具栏不再出现“选中自动布局”；验证导航图默认隐藏、可展开/收起；验证工作区进入和退出真实全屏，同时 `Esc` 能同步恢复按钮状态。
4. 不进行任何云资源创建、保存、发布或破坏性操作。
