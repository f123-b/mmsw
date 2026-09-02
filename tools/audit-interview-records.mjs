import fs from "node:fs";
import path from "node:path";

const quantile = (values, ratio) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1] : null;
const files = process.argv.slice(2);
if (!files.length) throw new Error("Usage: node tools/audit-interview-records.mjs <record.md> ...");
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const dialogue = text.split("## 对话记录")[1]?.split("## 问题理解诊断")[0] ?? "";
  const blocks = dialogue.split(/^### /m).filter(Boolean);
  const answers = blocks.filter((block) => block.startsWith("AI 回答"));
  const firstTokens = answers.map((block) => Number(block.match(/- 首 token：(\d+) ms/)?.[1])).filter(Number.isFinite);
  const totals = answers.map((block) => Number(block.match(/- 总耗时：(\d+) ms/)?.[1])).filter(Number.isFinite);
  const states = [...(text.split("## 问题理解诊断")[1]?.split("## 回答诊断")[0] ?? "").matchAll(/- 状态：([^\n]+)/g)].map((match) => match[1].trim());
  console.log(JSON.stringify({
    file: path.basename(file), mode: text.match(/- 自动回答：([^\n]+)/)?.[1]?.trim(),
    transcriptBlocks: { interviewer: blocks.filter((block) => block.startsWith("面试官")).length, candidate: blocks.filter((block) => block.startsWith("我 ·")).length },
    answerBlocks: answers.length, questionStates: states.reduce((counts, state) => ({ ...counts, [state]: (counts[state] ?? 0) + 1 }), {}),
    firstTokenMs: { p50: quantile(firstTokens, .5), p95: quantile(firstTokens, .95), max: firstTokens.length ? Math.max(...firstTokens) : null, over5s: firstTokens.filter((n) => n > 5000).length },
    totalMs: { p50: quantile(totals, .5), p95: quantile(totals, .95), max: totals.length ? Math.max(...totals) : null }
  }));
}
