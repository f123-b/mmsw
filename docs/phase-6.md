# Phase 6：Knowledge Base、Document Cache、Chunk 与 Hybrid Retrieval

## 当前状态

`Phase 6 IMPLEMENTATION COMPLETE`

## 已实现

- `DocumentParserRegistry` 支持按 MIME 注册 TXT/MD/HTML 或外部 PDF/DOCX/PPTX/XLSX/图片解析器。
- `DocumentMemoryCache` 按 SHA-256 key 复用解析结果，避免同一文件重复解析。
- `chunkText` 默认按约 800 token、120 token overlap 分块，并保留 document/filename/section/page metadata。
- `HybridRetriever` 组合关键词得分和 embedding cosine similarity，默认返回 Top 6。
- Reranker 和 Embedding Provider 均为接口，不绑定具体向量数据库或模型供应商。
- Answer Context Router 已限制 retrieval context 最大 6 chunks。

## 本地验证

- shared：19/19 测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

下一阶段实现 Preparation Agent、Workspace 文件边界、工具注册和审批策略。
