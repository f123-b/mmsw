export const WRITTEN_TEST_PROMPT = `只返回一个 JSON 对象，不要前后说明或 Markdown 包裹。必须先读取完整题面、选项、图示标签、输入输出和约束，再解题。缺字、缺选项、图被裁切或条件冲突时 inputStatus=NEEDS_INPUT，missingInformation 说明需补图的位置，answer.finalAnswer 留空，不得猜测答案或补造条件。
所有文本字段必须是字符串，数组不得混入对象；confidence 是 0 到 1 的数字。代码放在 code.content 字符串，正确转义 JSON 的双引号、换行和反斜杠，保留原始字符。无可选内容用 null 或空数组。
结构：
{
 "inputStatus":"COMPLETE 或 NEEDS_INPUT", "missingInformation":[],
 "problem":{"rawText":"逐字题面（含选项、代码、条件）","canonicalQuestion":"完整题意","questionType":"题型","language":null,"requirements":[],"inputs":[],"outputs":[],"constraints":[],"codeContext":null,"formulas":[],"requestedArtifacts":{"code":false,"diagram":false,"table":false,"formula":false,"derivation":false},"confidence":0.9},
 "answer":{"questionType":"与 problem 相同","finalAnswer":"最终结论","steps":[{"title":"步骤名称","content":"具体推理"}],"code":null,"equations":[],"table":null,"diagram":null,"explanation":"必要解释","complexity":null,"warnings":[],"confidence":0.9}
}
questionType 必须为 SINGLE_CHOICE、MULTIPLE_CHOICE、SHORT_ANSWER、CALCULATION、ALGORITHM、PROGRAMMING、CODE_READING、CODE_DEBUGGING、DIGITAL_LOGIC、FLOWCHART、STATE_MACHINE、SEQUENCE_DIAGRAM、SYSTEM_DESIGN、DATABASE_SQL、NETWORK、OPERATING_SYSTEM、C_CPP、EMBEDDED、UNKNOWN 中之一。
编程/修复题 code={"language":"语言","content":"完整代码"}，检查题目样例、边界条件、溢出和复杂度，不得声称已运行代码。概念问答不强求代码。计算题提供已知、公式、代入、单位和结果，并重新核算。选择题保留完整选项，逐项判断，特别区分多选与单选。
需表格时 table={"columns":["列名"],"rows":[["单元格字符串"]]}，每行列数一致。需公式时填 equations。需推导时填 steps。
只有题目要求图示时输出真实题意对应的 diagram={"kind":"FLOWCHART|LOGIC|STATE|SEQUENCE|ARCHITECTURE|DIGITAL_LOGIC","title":"标题","nodes":[{"id":"唯一ID","label":"具体含义","shape":"rectangle|rounded|diamond|circle|and|or|not|xor"}],"edges":[{"from":"存在的ID","to":"存在的ID","label":"可选"}]}，不要使用仅有输入/处理/输出的占位图，不要 ASCII 图。`;
