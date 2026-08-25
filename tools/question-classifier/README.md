# 本地面试语气分类模型

这个目录训练的是一个小型、CPU 友好的 ONNX 分类器，负责识别实时面试中的四种语气行为：

- `QUESTION`：完整问题
- `FOLLOW_UP`：依赖上一轮问答的追问或省略式提问
- `STATEMENT`：候选人回答、事实陈述或结论
- `OTHER`：嗯、换题、确认、思考停顿等非问题语句

训练语料不是简单关键词列表，而是由嵌入式、电机控制、FOC、电力电子、RTOS、通信和故障定位场景组成的面试官提问、候选人回答、上下文追问和口语/ASR 片段。`eval.jsonl` 是独立手写评估集，包含类似“那为什么不用 UART”“好，说说”“为什么不用编码器”等带上下文的真实片段。

## 训练

```powershell
npm ci
npm run prepare:question-classifier
```

发布 artifact 已随仓库版本化，`prepare:question-classifier` 会校验同一套 `model.onnx`、`labels.json`、`metrics.json`、`model-card.json` 及其 SHA256 manifest。这样 clean checkout、ONNX 单测、桌面运行时、Windows 打包和 `verify-package` 使用同一套固定字节内容。

如需重新训练模型，先运行 `generate_dataset.py` 和 `train_onnx.py`，确认评估结果后更新 `artifact-manifest.json`，再运行 `npm run prepare:question-classifier`。没有 manifest、文件缺失、文件过小、JSON 无法解析或 SHA256 不匹配时，准备步骤会明确失败。

当前模型是中文字符 n-gram TF-IDF + LogisticRegression 的领域化 ONNX 模型，不冒充 MiniLM。应用层只依赖 `LocalQuestionModel`，以后可以把同一接口替换为 MiniLM/DistilBERT ONNX 导出模型。
