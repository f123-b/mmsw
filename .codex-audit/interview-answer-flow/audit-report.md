# Interview Copilot 架构与产品优化审计

审计日期：2026-08-25

## 结论

项目已经具备音频采集、ASR、问题检测、RAG、项目事实、题库、答案校验和模型路由等基础模块。当前核心问题不是缺少功能，而是运行时问题状态机、知识治理状态和模型能力配置没有形成一条可靠闭环。

建议把产品从“实时转写后直接问模型”升级为“证据驱动的面试准备与实时答题系统”。

## 当前架构

```text
Rust Audio Sidecar
  -> RealtimeSession / ASR Provider
  -> TranscriptAggregator
  -> SpeechAct + AnchorResolver + QuestionDetector2
  -> Temporal QuestionDetector
  -> InterviewCoordinator
  -> Context Provider (Project Facts / Resume / Question Bank / RAG)
  -> AnswerAgent + OpenAI-compatible Provider
  -> StableAnswerStateMachine + Overlay
  -> SQLite History
```

离线知识链路：

```text
Resume / JD / Project Document / ZIP
  -> Parser / Importer
  -> Project Analyzer
  -> Projects / Facts / Sources / Questions
  -> Manual verification
  -> Retrieval during interview
```

## 三个截图步骤

1. 追问被拆成两次完整生成：健康度“有风险”。系统可以识别两句话，但不能判断第二句是补充要求还是新题，因而浪费生成并产生不一致答案。
2. “问题、定位、解决”三段被连续替换：健康度“严重”。前两题答案被取消，用户最后只能看到最后一个子问题。
3. “更新节奏、是否有隐患”被当成替换关系：健康度“严重”。第一题只留下两个字，界面没有保留未完成问题和被取消答案。

截图可见的无障碍风险：长答案密集、状态主要依赖文字变化、被替换内容没有持久可见历史。截图不足以验证键盘操作、焦点、读屏、缩放和完整对比度。

## 代码与真实记录证据

- QuestionDetector 对任何新的已确认问题，只要上一题仍是 confirmed/answering，就发出 `question_superseded`。
- InterviewCoordinator 每次 `answer()` 都先执行 `cancelAnswer("superseded")`。
- Renderer 收到 superseded 后把当前题直接换成新题，并显示“新问题已覆盖上一题”。
- 2026-08-25 13:43 开始的最近记录中，17 个识别问题有 6 个被覆盖；6 次回答均在已经出现首字后被取消。
- “最棘手的问题 -> 怎么定位 -> 最后怎么解决”被保存成三个问题，前两个被取消，只保留 44 和 23 个字的残片。
- 现有问题识别测试和协调器测试全部通过，因为测试覆盖“是否判成问题”，没有覆盖“连续多问时的意图保留和回答完整性”。

## 知识数据现状

- 10 个项目记录，但只有 3 条项目来源绑定，存在简历标题、文档标题和面试记录被误建为项目以及同一项目重复的问题。
- 245 条项目事实中，24 条已确认，81 条冲突。
- 82 道项目题；统一题库 510 题、238 张答案卡，但已人工验证答案卡为 0。
- 最近面试没有冻结具体 project_id / job_target_id，指代“这个项目”时容易跨项目检索。
- 日志已有 `QUALITY_UNGROUNDED_CLAIM`，但实时链路关闭质量修复并已向界面输出流式 delta，因此检测到问题也无法阻止用户看到不可靠内容。

## 目标运行时架构

```text
ASR Finals
  -> Turn Builder
  -> Question Group Extractor
       - ASR revision
       - same-question augmentation
       - parallel sub-question
       - follow-up
       - new topic
  -> Answer Scheduler
       - never erase answered/streaming questions
       - queue missing sub-answers
       - cancel only ASR revision before meaningful output or explicit user action
  -> Context Lock (profile + project + job + evidence snapshot)
  -> Evidence-bound Answer Planner
  -> Claim Gate
  -> Verified answer sections in Overlay
```

建议新增 `interview_turns`、`question_groups`、`question_items`、`question_relations`、`answer_runs`、`answer_sections`。保留原始转写、规范问题和问题关系，不再用一个 `superseded` 状态表达所有变化。

## 目标知识架构

事实需要拆成三个独立维度：

- 技术事实：源码或文档能否证明功能存在。
- 个人归属：用户是否确认自己负责或参与。
- 结果证据：指标、效果和现场故障是否有测量或本人确认。

允许的证据状态至少包括 `confirmed-code`、`confirmed-user`、`inferred`、`planned`、`risk`、`conflicting`、`unknown`。第一人称职责和成果只能使用 `confirmed-user`；技术实现可使用 `confirmed-code`；推断和风险只能以可能性表达。

导入流程应为：来源收件箱 -> 项目识别与去重 -> 事实抽取 -> 冲突/缺口待办 -> 有“都不对/不知道/暂不确认”的选择题 -> 面试材料包 -> 题库覆盖与模拟拷打。

## 模型配置中心

当前页面有多配置和任务路由的雏形，但实际仍是自由文本表单，Provider 运行层只实现 OpenAI-compatible Chat Completions，并用少量供应商名称启发式处理能力。

建议改为四层：

1. Provider 实例：预设供应商、自定义兼容服务、本地服务；密钥和 Base URL 独立保存。
2. Model Catalog：自动发现或手动添加模型，保存能力标签和健康状态。
3. Capability Check：分别验证流式、视觉、JSON、工具、embedding、取消和思考参数。
4. Task Routing：用已验证模型下拉选择实时回答、歧义识别、项目分析、题库生成、复盘等任务，并设置有序 fallback。

编辑草稿、保存配置和激活配置必须分开；切换时显示影响范围，面试启动后继续冻结快照。导入/导出配置时永不包含密钥。

## 表达难度

把回答长度/推理深度与语言难度分开。新增 `表达级别`（通俗、面试标准、专家）和 `术语解释` 开关。默认先说人话，再在必要时补标准术语；对术语密度做确定性检查。用户已确认掌握的词可加入个人词表，不熟悉的词自动补一句解释。

## 实施优先级

1. P0：Question Group + Answer Scheduler；删除“新题一律取消旧答案”的规则，补真实三段连续问测试。
2. P0：个人项目题启用严格 Claim Gate；校验失败时不展示未验证 delta，返回安全降级答案。
3. P1：项目去重、来源绑定、事实三维状态和缺口选择题；清理当前重复/误分类项目。
4. P1：Provider Adapter Registry、能力探测、模型目录和任务路由页面。
5. P2：按岗位/技能生成覆盖矩阵、追问题树、30 秒/1 分钟/3 分钟答案包和模拟拷打。
6. P2：表达级别、个人术语词表与面试后自动复盘回流。

## 验收指标

- 连续多问的子问题覆盖率 >= 98%。
- 后续子问题导致的已显示答案取消数 = 0。
- 第一人称高风险事实（职责、芯片、数字、结果）证据覆盖率 = 100%。
- 不受支持的高风险个人断言可见数 = 0。
- 每个任务路由只能选择已通过相应能力探测的模型。
- 真实录音回放测试必须统计 question-group recall、关系分类准确率、完整回答率和被取消答案率，而不只统计问题分类准确率。

