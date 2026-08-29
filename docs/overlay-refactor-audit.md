# Overlay 架构审查清单

本阶段只审查悬浮窗设计器、Overlay 窗口管理和鼠标命中，不涉及 ASR、问题识别、回答生成、RAG、数据库或面试算法。

## 已确认根因

1. `OverlayRoot` 同时承载运行态和布局编辑态。`DraggableResizablePanel` 在非编辑态仍可从面板容器进入拖动，resize handle 也只依赖 `!layout.locked` 渲染；因此运行态可能保留编辑器行为和视觉标记。
2. `OverlayManager` 的原生窗口仍覆盖整个显示器。控制栏、内容区和空白区最终都依赖 renderer 的 `elementsFromPoint`、IPC 往返和 `setIgnoreMouseEvents` 动态切换，控制栏第一击存在竞态，且内容区的交互策略会影响整块窗口。
3. 布局有三份运行来源：`OverlaySettingsStore`/`OverlayPreferences`、`HUDLayout` 默认计算结果和 renderer `localStorage`（v2/v3 及按显示器 key）。拖动过程中 renderer 立即写 localStorage，pointerup 再写 Preferences，重启和显示器切换时会发生 merge 覆盖。
4. 预览和真实布局虽然复用了 `resizeDesignerRect`，但 `PreviewWindow` 的 pointer handler 与 `preview-resize-fix.ts` 分别维护 resize 生命周期；后者通过 capture-phase 事件接管组件，说明根组件的 start-rect 责任边界不清晰。
5. CSS 存在多层 Overlay 主题和末尾覆盖规则。`styles.css` 末段对 `.overlay-root .resize-handle` 设置 `opacity: 1`，与运行态隐藏意图冲突；编辑边框、outline 和 handle 没有统一由 `data-layout-edit-mode` 门控。
6. `runtime-guard.ts` 在 renderer 观察到 `running + layoutEditing` 后异步调用 finish，是主进程状态转换之后的补救，而不是启动面试时的原子状态清理。
7. 默认行为仍是 `lockLayout: false`、`interactionMode: interactive`、`mousePassthrough: false`，不符合首次运行时安全默认；并且 `OverlayManager` 的字段初值和 index.ts 的 fallback 也默认 interactive。

## 当前正向基础

- `OverlaySettingsStore` 已能规范化布局、行为和外观字段，并通过 `overlay:preferences` 广播。
- `resizeDesignerRect` 已基于输入矩形计算八向 resize，几何单测覆盖了边界、吸附和显示器缩放映射。
- 结束面试、快捷键、截图、中键截图、Capture Protection 和面试 session 都由现有主进程链路负责，后续改动应保持这些入口不变。

## 分阶段策略

- Phase 2：先在主进程原子退出编辑态，renderer 只在编辑态渲染 handle/拖动行为，并收紧 CSS 门控；同时把内容 click-through 与控制栏命中拆开，补充状态/命中测试。
- Phase 3：把预览 pointerdown 的 `startRect/startPointer` 逻辑收回预览组件，删除 `preview-resize-fix.ts` 和入口安装。
- Phase 4：移除 OverlayRoot 的 localStorage 布局持久化；renderer 只保留拖动中的临时 state，pointerup 一次性提交 `OverlayPreferences`。
- Phase 5：将设置页设计器拆成 Designer、Canvas、Inspector，并把常用布局/外观置于一级界面，高级参数折叠。
- Phase 6：在不触碰业务状态的前提下评估控制栏/内容窗的原生窗口职责；若实现多窗口，统一由主进程广播同一份 HUD state 与 Preferences。

## 暂不纳入范围

不修改回答、ASR、问题识别、RAG、数据库、面试算法、历史记录或 session 生命周期；只修改显示层、布局、原生窗口管理和鼠标命中。
