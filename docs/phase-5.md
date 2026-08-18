# Phase 5：Profile、Resume、JD 与 Skill Router

## 当前状态

`Phase 5 IMPLEMENTATION COMPLETE`

## 已实现

- Profile 统一模型：language、resume、jobDescription、instructions、skills、knowledgeBaseIds 和时间字段。
- Material 明确区分 `rawContent` 与实时默认使用的 `summary`。
- Skill 模型包含 name、description、content、tags；ProfileStore 提供独立副本读写和 Skill 更新。
- Skill Router 按问题与 Skill 内容/标签相关度排序，默认只返回 Top 3。
- Answer Context Router 可直接消费 Profile summary、Skill 和 retrieval context，避免全量简历注入 Prompt。

## 本地验证

- shared：16/16 测试通过。
- `npm run typecheck`：通过。

Phase 6 将实现知识库文档缓存、解析、分块、Embedding/Retrieval 抽象和混合检索。
