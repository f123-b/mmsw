# AskCc 功能等价复刻技术规格书

**文档版本：V1.0**  
**目标平台：Windows 优先，后续兼容 macOS**  
**产品形态：Electron Desktop + Rust Audio Sidecar + Realtime Backend + Preparation Agent**  
**开发目标：功能等价实现，不复制 AskCc 专有源码、服务端代码、官方题库或私有数据**

---

# 1. 项目目标

开发一套实时 AI 面试辅助桌面软件，核心能力包括：

- 同时采集麦克风与电脑系统音频
- 不依赖声纹识别即可区分“用户”和“对方”
- 实时语音转文字
- 自动识别完整问题
- 避免问题尚未说完就反复生成答案
- 自动生成面试回答
- 支持手动问题、自动问题、截图问题
- 支持答案流式输出
- 支持简历、JD、项目资料、个人知识库
- 支持 RAG
- 支持项目 Skill
- 支持面试前 Preparation Agent
- 支持桌面悬浮窗
- 支持悬浮窗无焦点模式
- 支持快捷键
- 支持会话恢复和 WebSocket 自动重连
- 支持本地项目和会话管理
- 支持多模型
- 支持后续扩展 Web 管理端、手机端

最终产品不依赖 AskCc 的任何服务。

---

# 2. 核心设计原则

## 2.1 音频物理隔离优先

禁止将“声纹识别”作为主要说话人区分手段。

采用两条独立音频路径：

```text
麦克风
   ↓
MIC Channel
   ↓
Left Channel

电脑系统声音
   ↓
WASAPI Loopback
   ↓
Right Channel
```

定义：

```text
LEFT  = User / Microphone
RIGHT = Remote / System Audio
```

因此 Zoom、Teams、腾讯会议、飞书会议、浏览器面试等场景中，对方声音直接来自系统音频。

这样可以从根本上避免：

- 用户声音被错误识别为面试官
- 声纹漂移
- 环境音导致声纹失效
- 不同耳机/麦克风导致声纹特征变化
- 多人面试无法处理

---

# 3. 总体系统架构

```text
┌──────────────────────────────────────────────┐
│                Desktop Client                │
│                                              │
│ React Renderer                               │
│     │                                        │
│     │ IPC                                    │
│     ▼                                        │
│ Electron Main                                │
│   │          │           │          │        │
│   │          │           │          │        │
│ Audio     Overlay       Local      Session    │
│ Manager   Manager       Agent      Manager    │
│   │                      │                    │
│   ▼                      ▼                    │
│ Rust Audio            SQLite                 │
│ Sidecar               Workspace              │
│   │                   Skills                 │
│   │                   Profiles               │
│   │                                           │
└───┼───────────────────────────────────────────┘
    │
    │ WebSocket
    │ PCM + JSON
    ▼
┌──────────────────────────────────────────────┐
│              Realtime Backend                │
│                                              │
│ Gateway                                      │
│   ↓                                          │
│ Session Manager                              │
│   ↓                                          │
│ Streaming ASR                                │
│   ↓                                          │
│ Transcript Stabilizer                        │
│   ↓                                          │
│ Question Extractor                           │
│   ↓                                          │
│ Context Router                               │
│   ├── Resume/JD                              │
│   ├── Skills                                 │
│   ├── Conversation                           │
│   └── Vector RAG                             │
│   ↓                                          │
│ Answer Agent                                 │
│   ↓                                          │
│ Streaming Output                             │
└──────────────────────────────────────────────┘
```

---

# 4. 推荐技术栈

## Desktop

```text
Electron
TypeScript
React
Vite
Zustand
TailwindCSS
React Markdown
Shiki
Mermaid
```

## Audio Sidecar

```text
Rust
Windows WASAPI
cpal / windows-rs
rubato 或 equivalent resampler
serde
serde_json
```

Windows 首版必须优先采用 WASAPI 原生能力。

## Backend

建议：

```text
Python FastAPI
+
WebSocket
+
asyncio
```

或者：

```text
Node.js
+
Fastify
+
WebSocket
```

推荐 Python，因为：

- ASR 生态成熟
- AI SDK 丰富
- RAG 工具丰富
- 向量库接入方便
- 文档处理方便

## 数据库

服务端：

```text
PostgreSQL
```

向量：

```text
pgvector
```

客户端：

```text
SQLite
```

ORM 可使用：

```text
Drizzle ORM
```

---

# 5. Desktop 进程设计

必须采用严格三层：

```text
Renderer
   ↓
Preload
   ↓
Main
```

Renderer 禁止直接拥有 Node 完整权限。

## Main Process 负责

```text
Window Manager
Overlay Manager
Audio Process Manager
Screenshot Manager
Shortcut Manager
Session Manager
Updater
Database
Filesystem
Agent Runtime
Authentication
WebSocket Client
```

## Renderer 负责

```text
UI
State
Transcript Rendering
Answer Rendering
Settings
Profile
Projects
History
Knowledge
Agent UI
```

---

# 6. Rust Audio Sidecar

程序名称建议：

```text
interview-audio.exe
```

Electron Main：

```text
spawn(interview-audio.exe)
```

Sidecar 与 Electron：

```text
stdout → PCM Binary

stderr → Health JSON
```

---

# 7. Audio Sidecar CLI

必须支持：

```text
interview-audio.exe --list-devices --json
```

返回：

```json
{
  "inputs": [],
  "outputs": []
}
```

---

支持：

```text
--probe-only
```

检测：

```text
microphone
loopback
resampler
device initialization
```

---

支持：

```text
--meter-only
```

实时输出：

```json
{
  "type": "meter",
  "mic": 0.35,
  "system": 0.71
}
```

---

正式工作：

```text
--input-device-id xxx
--output-device-id xxx
```

---

# 8. Audio Format

统一使用：

```text
Sample Rate:
16000 Hz

Sample:
PCM16 LE

Channels:
2

LEFT:
Microphone

RIGHT:
System Loopback
```

单个 frame：

```text
BYTE 0-1 = microphone int16

BYTE 2-3 = system int16
```

使用：

```text
40 ms
```

作为标准上传 packet。

计算：

```text
16000 × 0.04
= 640 frames
```

每 frame：

```text
4 bytes
```

所以：

```text
640 × 4
= 2560 bytes
```

每个音频 WebSocket packet：

```text
2560 bytes
```

---

# 9. 音频健康检测

Sidecar stderr：

```json
{
  "type": "audio_health",
  "mic": "ok",
  "loopback": "ok",
  "timestamp": 123456789
}
```

错误：

```json
{
  "type": "audio_error",
  "component": "loopback",
  "reason": "DEVICE_INVALIDATED"
}
```

Electron 必须自动尝试恢复。

状态：

```text
STARTING
READY
DEGRADED
RECOVERING
FAILED
```

设备掉线后禁止直接导致整个应用退出。

---

# 10. Realtime Session

建立面试时：

```text
POST /api/v1/interviews
```

返回：

```json
{
  "interviewId": "...",
  "status": "created"
}
```

然后：

```text
POST /api/v1/interviews/{id}/ws-ticket
```

返回短期 ticket：

```json
{
  "ticket": "...",
  "expiresIn": 60
}
```

连接：

```text
WSS /api/v1/realtime/{interviewId}?ticket=xxx
```

禁止长期 Access Token 直接用于 WebSocket URL。

---

# 11. WebSocket 数据协议

WebSocket 同时传递：

## Binary

```text
PCM audio
```

## JSON

```text
control
ASR
question
answer
health
session state
```

---

# 12. Client → Server 消息

## client_ready

```json
{
  "type": "client_ready"
}
```

## heartbeat

```json
{
  "type": "heartbeat",
  "timestamp": 0
}
```

## manual_answer

```json
{
  "type": "answer_request",
  "mode": "manual_text",
  "text": "解释一下 volatile"
}
```

## answer_latest_question

```json
{
  "type": "answer_request",
  "mode": "latest_remote_transcript"
}
```

## screenshot

```json
{
  "type": "answer_request",
  "mode": "screenshot",
  "attachmentId": "..."
}
```

## cancel

```json
{
  "type": "answer_cancel",
  "answerId": "..."
}
```

---

# 13. Server → Client 消息

必须支持：

```text
connection_ready
heartbeat_ack
asr_status
asr_partial
asr_final
question_candidate
question_confirmed
answer_start
answer_delta
answer_end
answer_cancelled
runtime_error
```

---

# 14. Streaming ASR

必须分别维护：

```text
MIC transcript

REMOTE transcript
```

其中问题检测主要使用：

```text
REMOTE transcript
```

MIC transcript 主要用于：

```text
识别用户正在回答
记录用户答案
上下文理解
避免重复生成
后续面试分析
```

---

# 15. Transcript 数据结构

```typescript
interface TranscriptSegment {
  id: string

  source: "mic" | "remote"

  text: string

  startMs: number
  endMs: number

  final: boolean

  confidence?: number
}
```

必须同时保留：

```text
partial
final
```

禁止将 partial 直接永久写入历史。

---

# 16. Transcript Stabilizer

负责：

```text
ASR 修正
重复片段合并
partial replacement
finalization
时间排序
断句
噪音过滤
```

例如 ASR：

```text
FOC的

FOC的电

FOC的电流环

FOC的电流环怎么
```

UI 不允许生成四条记录。

最终：

```text
FOC 的电流环怎么设计？
```

---

# 17. Question Detector

这是整个系统最重要的模块之一。

禁止：

```text
收到一句 ASR
↓
直接生成答案
```

正确链路：

```text
Remote ASR
   ↓
Transcript Buffer
   ↓
Question Candidate Detector
   ↓
Question Boundary Detector
   ↓
Semantic Completeness
   ↓
Confidence
   ↓
Debounce
   ↓
Question Confirmed
```

---

# 18. Question State Machine

状态：

```text
IDLE

LISTENING

POSSIBLE_QUESTION

WAITING_COMPLETION

CONFIRMED

ANSWERING
```

状态转移：

```text
IDLE
 ↓
REMOTE speech
 ↓
LISTENING
 ↓
疑问意图出现
 ↓
POSSIBLE_QUESTION
 ↓
继续语音
 ↓
WAITING_COMPLETION
 ↓
完整语义 + silence
 ↓
CONFIRMED
 ↓
ANSWERING
```

---

# 19. Question Completeness

输出：

```json
{
  "question": "为什么中断服务程序应该尽量短？",
  "confidence": "high",
  "score": 0.93,
  "source": "extractor"
}
```

confidence：

```text
HIGH
MEDIUM
LOW
```

---

# 20. 自动触发建议条件

默认：

```text
completeness_score >= 0.82
```

并满足：

```text
至少 500ms 没有新增关键语义
```

同时判断：

```text
不是重复问题

不是用户正在回答

不是对方对上一题的补充短句

不是纯寒暄

不是陈述句
```

---

# 21. 双层 Question Detector

为了降低延迟，采用：

## Layer 1

规则检测：

```text
疑问词
问号语义
语速停顿
句法
ASR final
silence
```

速度目标：

```text
<10ms
```

## Layer 2

小模型语义判断：

输入：

```text
最近 10~20 秒 Remote Transcript
```

输出：

```json
{
  "isQuestion": true,
  "complete": true,
  "question": "...",
  "confidence": 0.91
}
```

不要用主回答大模型完成这个步骤。

---

# 22. Deduplication

维护：

```text
lastQuestionEmbedding
lastQuestionText
lastQuestionTime
```

如果：

```text
semantic similarity > 0.90
```

并且：

```text
时间差 < 15s
```

默认认为是同一问题。

禁止重复触发。

---

# 23. Supersede

场景：

```text
面试官：
你说一下 volatile...

系统开始生成

面试官：
以及它与 const 有什么区别？
```

系统应：

```text
旧 Question
      ↓
SUPERSEDED
      ↓
cancel old generation
      ↓
新完整 Question
```

协议：

```json
{
  "type": "answer_cancel",
  "reason": "superseded"
}
```

---

# 24. Stable Answer UI

禁止：

```text
旧答案消失
↓
空白
↓
加载
↓
新答案
```

必须：

```text
旧答案保持显示
       ↓
后台生成新答案
       ↓
收到第一个 token
       ↓
Atomic Replace
```

---

# 25. Answer Agent

输入：

```text
Current Question

Resume Context

JD Context

Relevant Skills

Retrieved Knowledge

Recent Transcript

Previous Questions

Answer Preferences
```

输出必须针对面试。

禁止默认生成大段文章。

---

# 26. 回答结构

默认建议：

```text
【核心回答】

2~4 行

【关键点】

• 关键点
• 关键点
• 关键点

【项目结合】

如果适用，给一条项目回答
```

例如：

```text
中断服务程序应该尽量短，核心原因是减少中断占用时间，
降低其他中断和实时任务被阻塞的风险。

关键点：
• 只处理最紧急的工作
• 清标志、搬数据、发通知
• 耗时任务放主循环或 RTOS Task
```

---

# 27. Answer Modes

支持：

```text
FAST
NORMAL
DEEP
```

### FAST

目标：

```text
首 token < 1.5s
```

回答：

```text
50~120 中文字
```

### NORMAL

```text
100~250 字
```

### DEEP

适合：

```text
项目深挖
系统设计
代码
算法
```

---

# 28. Model Router

不要绑定单模型。

定义：

```text
model-router
```

可以配置：

```text
OpenAI
Gemini
Claude
DeepSeek
Qwen
OpenAI-compatible API
```

Router：

```text
普通八股
→ Fast Model

项目问题
→ Reasoning Model

截图
→ Vision Model

简单定义
→ Low Latency Model
```

---

# 29. Context Router

禁止每一题把整个资料库发给模型。

流程：

```text
Question
 ↓
Context Router
 ↓
┌───────────────┐
│ Resume        │
│ JD            │
│ Skill         │
│ RAG           │
│ Transcript    │
└───────────────┘
 ↓
Context Pack
 ↓
LLM
```

---

# 30. Profile

Profile 数据模型：

```typescript
interface Profile {
  id: string
  name: string

  language: string

  resume?: Material
  jobDescription?: Material

  instructions?: string

  skills: Skill[]

  knowledgeBaseIds: string[]

  createdAt: number
  updatedAt: number
}
```

---

# 31. Material

```typescript
interface Material {
  rawContent: string
  summary: string
}
```

Resume/JD 首次导入后：

```text
rawContent
 ↓
Summary Agent
 ↓
summary
```

实时面试默认只注入：

```text
summary
```

需要细节时才检索 rawContent。

---

# 32. Skill

```typescript
interface Skill {
  id: string

  name: string

  description: string

  content: string

  tags: string[]
}
```

例如：

```text
FOC 电机控制

description:
STM32 PMSM FOC 项目经验

content:
- 系统架构
- Clarke/Park
- SVPWM
- ADC DMA
- PWM同步
- PI
- 调试问题
- 项目难点
- 可回答范围
```

推荐单 Profile：

```text
最多 10~20 个主动 Skills
```

---

# 33. Skill Router

Question：

```text
为什么电流采样要跟 PWM 同步？
```

Router：

```text
匹配：
FOC Skill

不匹配：
Linux Gateway
TCP/IP
LVGL
```

只将：

```text
Top 1~3 Skills
```

加入 Context。

---

# 34. Knowledge Base

支持：

```text
PDF
DOCX
TXT
MD
HTML
PPTX
XLSX
PNG
JPG
```

流程：

```text
Upload
 ↓
Parser
 ↓
Markdown / Plain Text
 ↓
Chunk
 ↓
Embedding
 ↓
Vector DB
```

---

# 35. Chunk

推荐：

```text
500~900 tokens
```

overlap：

```text
80~150 tokens
```

同时保存 metadata：

```json
{
  "documentId": "...",
  "filename": "...",
  "section": "...",
  "page": 3
}
```

---

# 36. Retrieval

默认：

```text
Hybrid Search
```

组合：

```text
Vector Similarity

+

BM25 / Keyword
```

然后：

```text
Reranker
```

最终：

```text
Top 3~6 chunks
```

进入上下文。

---

# 37. Document Cache

本地计算：

```text
SHA256(file)
```

缓存：

```text
cache/documents/{sha256}.md
```

同文件再次导入：

```text
直接读取 cache
```

避免重复解析。

---

# 38. Preparation Agent

实现独立 Agent 页面。

能力：

```text
读取简历
分析 JD
生成 Skill
整理项目
补充面试问题
编辑 Profile
查询知识库
整理项目文档
分析历史面试
```

---

# 39. Agent Tools

第一版至少：

```text
read_file

write_file

edit_file

list_files

search_files

parse_document

get_profile

update_profile

create_skill

update_skill

retrieve_knowledge

web_search
```

---

# 40. Workspace

每 Profile：

```text
workspace/
└── {profileId}/
    ├── resume/
    ├── jd/
    ├── projects/
    ├── skills/
    ├── knowledge/
    └── notes/
```

Agent 可操作 workspace。

---

# 41. Tool Approval

支持两种模式：

```text
ASK_EVERY_TIME

FULL_ACCESS
```

高风险操作：

```text
delete
overwrite
external request
```

应可单独配置审批。

---

# 42. Screenshot Answer

Electron Main 使用：

```text
desktopCapturer
```

截图后：

```text
MAX_DIMENSION = 1280
```

优先：

```text
PNG
```

如果：

```text
PNG > 2MB
```

则：

```text
JPEG Quality 85
```

上传：

```json
{
  "attachmentId": "...",
  "mimeType": "image/jpeg",
  "width": 1280,
  "height": 720
}
```

---

# 43. Overlay

Electron：

```typescript
new BrowserWindow({
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true
})
```

同时：

```text
setAlwaysOnTop(true, "screen-saver")
```

---

# 44. Overlay Mode

## Interactive Mode

```text
focusable=true
mouse=true
keyboard=true
```

## Passive Mode

```text
focusable=false
ignoreMouseEvents=true
```

用途是减少对当前会议/浏览器窗口焦点的干扰。

如果启用系统提供的 content protection，应作为独立隐私选项，不作为规避第三方监控策略的保证。

---

# 45. Overlay UI

悬浮窗只展示最重要数据：

```text
Question

Answer

Status
```

禁止把主程序大量设置塞入 Overlay。

推荐：

```text
┌──────────────────────────────┐
│ Q: 什么是优先级反转？        │
├──────────────────────────────┤
│ 优先级反转是低优先级任务... │
│                              │
│ • Mutex                      │
│ • Priority inheritance       │
│ • RTOS                       │
└──────────────────────────────┘
```

---

# 46. Overlay Answer UX

答案必须：

```text
字号较大

行距大

每段不超过 3~4 行

重点 bullet 化

禁止超长连续文本
```

---

# 47. Global Shortcuts

默认：

```text
Answer latest
Ctrl + Alt + A

Screenshot answer
Ctrl + Alt + S

Toggle overlay
Ctrl + Alt + D

Toggle automation
Ctrl + Alt + X

End interview
Ctrl + Alt + Q
```

另外支持：

```text
Ctrl + Alt + ↑
Ctrl + Alt + ↓
Ctrl + Alt + ←
Ctrl + Alt + →
```

调整 Overlay。

所有快捷键必须允许修改。

---

# 48. Automation Mode

```text
MANUAL

AUTO
```

## MANUAL

只有：

```text
快捷键
手动输入
截图
```

才生成。

## AUTO

Question Detector：

```text
CONFIRMED
```

后自动生成。

---

# 49. 本地数据目录

Windows：

```text
%APPDATA%/InterviewCopilot/
```

建议：

```text
InterviewCopilot/
├── app.db
├── agent.db
├── logs/
├── workspace/
├── cache/
│   ├── documents/
│   └── screenshots/
└── config/
```

---

# 50. SQLite 数据表

至少：

```text
profiles

skills

projects

interviews

interview_questions

transcripts

answers

settings

conversations

agent_messages

documents

knowledge_bases
```

---

# 51. Interview 表

```text
id

profile_id

started_at

ended_at

status

language

automation_mode

created_at
```

---

# 52. Transcript 表

```text
id

interview_id

source

text

start_ms

end_ms

final

confidence

created_at
```

---

# 53. Question 表

```text
id

interview_id

text

confidence

source

detected_at

status
```

status：

```text
candidate
confirmed
superseded
answered
ignored
```

---

# 54. Answer 表

```text
id

question_id

text

model

latency_first_token

latency_total

cancel_reason

created_at
```

---

# 55. Session Manager

状态：

```text
IDLE

CREATING

CONNECTING

READY

RUNNING

RECONNECTING

ENDING

ENDED

ERROR
```

严禁通过多个 boolean：

```text
isRunning
isConnected
isCreating
...
```

拼状态。

统一状态机管理。

---

# 56. WebSocket Recovery

断网：

```text
CONNECTED
 ↓
DISCONNECTED
 ↓
RECONNECTING
```

采用：

```text
1s
2s
4s
8s
10s
10s
...
```

指数退避。

最大：

```text
10s
```

---

# 57. Audio Backpressure

网络堵塞时禁止无限缓存 PCM。

最大缓冲：

```text
2~3 秒
```

超过：

```text
丢弃最老音频
```

目标：

> 宁可丢旧音频，也不能让 ASR 延迟逐渐增长到几十秒。

---

# 58. Latency Budget

目标：

## Audio

```text
Capture → Network
<100 ms
```

## ASR Partial

```text
<400 ms
```

## Question Detection

问题结束后：

```text
500~900 ms
```

## LLM

首 token：

```text
FAST <1.5s

NORMAL <2.5s
```

因此总体验：

```text
问题结束
↓
约 1~3 秒
↓
看到答案
```

---

# 59. UI 页面

至少：

```text
Home

Profiles

Profile Detail

Resume

Job Description

Skills

Knowledge Base

Preparation Agent

Interview Setup

Interview History

Interview Detail

Settings
```

---

# 60. Interview Setup

开始前必须完成：

```text
Profile

Microphone

System Audio

Audio Test

Language

Automation Mode

Answer Mode
```

显示：

```text
MIC meter

SYSTEM meter
```

两条独立波形。

---

# 61. 主界面

主界面需要：

```text
当前 Profile

快速开始面试

Preparation Agent

最近面试

Profiles

Knowledge
```

禁止堆砌大量低频功能。

---

# 62. Interview History

每场保存：

```text
完整 Transcript

Detected Questions

AI Answers

User Answers

Duration

Profile

Model

Latency
```

---

# 63. Post Interview Analysis

面试结束后可生成：

```text
问题清单

回答质量

遗漏知识点

薄弱方向

项目表达问题

推荐复习内容

推荐新增 Skills
```

---

# 64. Provider Abstraction

所有外部 AI Provider 必须抽象。

例如：

```typescript
interface ASRProvider {}

interface LLMProvider {}

interface EmbeddingProvider {}

interface RerankProvider {}

interface VisionProvider {}
```

禁止业务代码：

```text
直接 import 某一个厂商 SDK
```

---

# 65. ASR Provider

可以接：

```text
OpenAI Realtime / transcription

Deepgram

AssemblyAI

Azure Speech

Google Speech

FunASR server

Whisper streaming service
```

必须做到可替换。

---

# 66. 用户自定义 API

Settings 支持：

```text
Base URL

API Key

Model

Timeout
```

兼容：

```text
OpenAI-compatible
```

例如：

```text
DeepSeek

Qwen

自建 LiteLLM

本地 Gateway
```

---

# 67. Prompt 架构

禁止使用一个巨大 Prompt。

拆分：

```text
system/base

interview-style

profile-context

skill-context

retrieval-context

question

output-format
```

通过 Prompt Builder 动态拼装。

---

# 68. Answer Prompt 核心要求

模型必须知道：

```text
这是实时面试

回答必须能让用户快速阅读

不得输出长篇论文

优先给直接答案

再给关键点

仅在有真实资料时引用用户项目

禁止虚构项目经验
```

---

# 69. 数据真实性

如果 Profile 没有：

```text
EtherCAT
```

模型不得：

> “我在项目中使用 EtherCAT……”

只能回答：

> “EtherCAT 是……”

这一条必须通过 Prompt + Context Policy 双层约束。

---

# 70. Logging

客户端：

```text
logs/app.log

logs/audio.log

logs/session.log
```

服务端：

```text
request_id

session_id

interview_id

answer_id
```

全部结构化日志。

禁止记录：

```text
完整 API Key
Access Token
Password
```

---

# 71. Metrics

至少记录：

```text
audio_packet_latency

ws_rtt

asr_partial_latency

asr_final_latency

question_detection_latency

question_confidence

answer_first_token

answer_total_latency

answer_cancel_rate

duplicate_question_rate

reconnect_count
```

这部分对于优化实时体验非常重要。

---

# 72. 错误体系

统一错误码。

例如：

```text
AUDIO_DEVICE_NOT_FOUND

AUDIO_DEVICE_INVALIDATED

AUDIO_CAPTURE_FAILED

WS_CONNECT_FAILED

WS_AUTH_FAILED

ASR_FAILED

QUESTION_EXTRACTOR_FAILED

LLM_FAILED

RAG_FAILED

SCREENSHOT_FAILED
```

UI 不显示底层堆栈。

---

# 73. Security

必须做到：

```text
API Key 不放 Renderer

Token 不放 URL，临时 WS ticket 除外

Preload 使用 contextBridge

关闭 nodeIntegration

启用 contextIsolation

限制 IPC Channel

敏感配置系统加密存储
```

Windows：

```text
DPAPI
```

macOS：

```text
Keychain
```

---

# 74. 推荐代码目录

```text
interview-copilot/
│
├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   │   ├── main/
│   │   │   ├── preload/
│   │   │   └── renderer/
│   │   └── package.json
│   │
│   └── server/
│       ├── api/
│       ├── realtime/
│       ├── asr/
│       ├── question/
│       ├── answer/
│       ├── rag/
│       ├── agent/
│       └── providers/
│
├── crates/
│   └── audio-sidecar/
│       ├── src/
│       │   ├── wasapi/
│       │   ├── capture/
│       │   ├── resample/
│       │   └── main.rs
│       └── Cargo.toml
│
├── packages/
│   ├── protocol/
│   ├── shared/
│   ├── database/
│   └── prompt/
│
├── docs/
│
└── tests/
```

---

# 75. Protocol Package

所有 Client / Server 消息：

```text
packages/protocol
```

定义唯一 schema。

推荐：

```text
Zod
```

或者 JSON Schema。

禁止 Client 和 Server 各自复制一份接口类型。

---

# 76. 第一阶段开发顺序

## Phase 1

完成：

```text
Electron
React
Overlay
Audio Sidecar
WASAPI Loopback
Mic Capture
Audio Meter
```

验收：

> 在腾讯会议播放远端声音时，可以看到 System 波形；用户说话只明显出现在 Mic 波形。

---

# 77. Phase 2

完成：

```text
WebSocket

PCM streaming

ASR

Transcript
```

验收：

```text
MIC
REMOTE
```

两条 Transcript 可以稳定分离。

---

# 78. Phase 3

完成：

```text
Question Detector

Dedup

Debounce

Supersede
```

这是最重要阶段。

测试：

面试官说：

```text
你能不能说一下...

FOC 中...

为什么需要进行...

Clarke 和 Park 变换？
```

系统只能触发一次：

```text
为什么 FOC 需要进行 Clarke 和 Park 变换？
```

不能触发四次。

---

# 79. Phase 4

完成：

```text
Answer Agent

Streaming

Stable Answer UI

Model Router
```

---

# 80. Phase 5

完成：

```text
Profile

Resume

JD

Skill
```

---

# 81. Phase 6

完成：

```text
Knowledge Base

Document Parser

Embedding

RAG
```

---

# 82. Phase 7

完成：

```text
Preparation Agent

Workspace

Tools
```

---

# 83. Phase 8

完成：

```text
History

Interview Analysis

Metrics

Recovery

Updater
```

---

# 84. 核心验收测试

## TEST-001

播放电脑视频。

期望：

```text
System Channel 有声音

Mic Channel 无明显声音
```

---

## TEST-002

用户说话。

期望：

```text
Mic Channel 有声音

System Channel 不应重复收录
```

---

## TEST-003

面试官说半句话。

系统：

```text
不得生成答案
```

---

## TEST-004

面试官问题完成。

```text
<1 秒确认 Question
```

---

## TEST-005

同一个问题 ASR 修正 5 次。

只允许：

```text
1 Answer
```

---

## TEST-006

AI 正在回答，面试官继续补充问题。

旧 Answer：

```text
cancel / supersede
```

新答案启动。

---

## TEST-007

WebSocket 断开。

客户端自动：

```text
Reconnect
```

不退出应用。

---

## TEST-008

音频设备拔掉。

应用：

```text
显示 DEGRADED

重新枚举

恢复后继续
```

不得闪退。

---

## TEST-009

LLM 服务失败。

UI：

```text
保留 Question

显示 Retry

不丢 Transcript
```

---

# 85. Question Detector 验收指标

目标：

```text
完整问题召回率 > 95%

错误自动回答率 < 5%

重复回答率 < 2%

问题确认平均延迟 < 900ms
```

真实面试录音必须建立测试数据集。

禁止仅依赖人工测试。

---

# 86. Audio 验收

持续运行：

```text
2 小时
```

要求：

```text
无内存持续增长

无音频延迟持续增长

无 Sidecar 崩溃

无 WebSocket backlog
```

---

# 87. 性能目标

Desktop：

```text
空闲 CPU <5%

实时工作 CPU <20%
```

不强制限制安装包体积。

内存目标：

```text
<600MB
```

但优先保证稳定性。

---

# 88. 产品开发优先级

P0：

```text
双通道 Audio

ASR

Question Detector

Answer

Overlay

Profile
```

P1：

```text
RAG

Skills

Screenshot

History

Agent
```

P2：

```text
Web 管理端

云同步

多设备

macOS
```

---

# 89. 明确禁止的实现

禁止：

```text
只通过声纹判断面试官

ASR partial 每变化一次就请求 LLM

一个问题同时创建多个 Answer

将完整知识库全部塞进 Prompt

Renderer 保存 API Key 明文

WebSocket 无限缓存

所有逻辑都写在 React Component

Electron Main 单文件几千行

大量 boolean 管理 Session 状态

异常直接 process.exit

音频 Sidecar 崩溃导致整个 Desktop 崩溃
```

---

# 90. 与 AskCc 等价但应优化的部分

重点不是逐像素克隆。

需要保留 AskCc 已验证有效的思想：

```text
Electron Desktop

Rust Audio Sidecar

WASAPI Loopback

双音频 Channel

Realtime WebSocket

Question Extractor

Auto / Manual

Streaming Answer

Profile

Skills

RAG

Preparation Agent

Overlay
```

同时重点优化：

```text
Question Detector

答案稳定性

重复回答

ASR 修正

异常恢复

模型 Router

RAG 精度

用户可配置 Provider
```

---

# 91. 最终产品关键链路

整个系统最重要的一条链：

```text
WASAPI
 ↓
MIC + SYSTEM
 ↓
16k PCM Stereo
 ↓
WebSocket
 ↓
Streaming ASR
 ↓
Transcript Stabilizer
 ↓
Question Detector
 ↓
Dedup / Debounce
 ↓
Question Confirmed
 ↓
Context Router
 ↓
Skill + Resume + JD + RAG
 ↓
Model Router
 ↓
LLM Streaming
 ↓
Stable Answer
 ↓
Overlay
```

如果这条链做对，产品核心体验就成立。

---

# 92. Codex 执行要求

Codex 实现过程中必须遵循以下原则：

1. 不允许未经说明擅自删除需求。
2. 不允许为了快速运行把所有模块堆进单文件。
3. 所有跨进程协议必须有统一 schema。
4. 所有 Session 逻辑必须状态机化。
5. Audio Sidecar 与 Desktop 生命周期必须解耦。
6. Provider 必须接口化。
7. Question Detector 必须独立模块。
8. Answer Generator 不得直接监听原始 ASR。
9. RAG 必须通过 Context Router。
10. UI 不得直接调用 Provider。
11. API Key 不允许进入 Renderer。
12. 所有核心路径必须写自动测试。
13. 所有错误必须有错误码。
14. 每一个阶段完成后执行测试，再进入下一阶段。
15. 不允许在测试失败情况下通过删除测试解决。
16. 关键架构改变必须同步修改 `/docs`。

---

# 93. Definition of Done

项目只有同时满足以下条件，才认为完成核心功能：

```text
✓ MIC / System Audio 完全分离

✓ 实时 ASR

✓ 问题自动检测

✓ 不提前回答

✓ 不重复回答

✓ 支持 Supersede

✓ 答案流式生成

✓ Overlay 稳定

✓ Profile

✓ Resume / JD

✓ Skills

✓ RAG

✓ Screenshot

✓ Manual / Auto

✓ Session Recovery

✓ Audio Recovery

✓ History

✓ Preparation Agent

✓ 多 Provider

✓ 自动测试

✓ 2 小时稳定运行测试
```

---

# 94. 产品最终定位

目标不是制作 AskCc 客户端的复制品，而是实现：

```text
AskCc 已验证的桌面实时面试架构

+

更可靠的问题边界识别

+

更稳定的答案更新机制

+

可替换 AI Provider

+

更强的个人项目 / Skill / RAG

+

完全独立可控的服务端
```

最终形成完整闭环：

```text
面试前
Preparation Agent
      ↓
Profile / Resume / JD / Skills
      ↓

面试中
Audio → ASR → Question → RAG → LLM
      ↓

面试后
Transcript → Review → Weakness → Skill Update
      ↓

下一次面试
```

这才是整个系统应该实现的最终形态。