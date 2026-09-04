import type { JSX } from "react";
import "./project-quick-start.css";

export const PROJECT_OVERVIEW_TEMPLATE = `# 我的项目说明

请把【填写】替换成真实信息；不确定的地方写“尚未确认”，不要编造数据。

## 1. 项目目标与边界
项目名称：【填写】
解决的问题、使用场景：【填写】
项目归属：个人 / 团队 / 部分负责 / 仅供学习参考
我实际负责的模块：【填写】
不属于我负责的部分：【填写】

## 2. 架构与数据流
硬件、芯片、软件版本：【填写】
主要模块与调用关系：【填写】
数据从哪里输入、经过哪些处理、输出到哪里：【填写】

## 3. 关键参数
参数 / 数值和单位 / 条件 / 来源文件与位置：【填写】

## 4. 设计取舍
选择了什么方案：【填写】
为什么选择、对比了什么替代方案、代价是什么：【填写】
来源文件或本人决策记录：【填写】

## 5. 一个真实问题
现象 → 排查过程 → 根因 → 修改 → 验证结果：【填写】

## 6. 测试与不足
测试条件、方法、实际结果、对应报告：【填写】
尚未解决的问题、下一步计划：【填写】
`;
export const PROJECT_QA_TEMPLATE = `问题：这个项目的目标是什么，你负责了哪些部分？
答案：【填写真实目标与自己的负责边界】

问题：为什么选择这个技术方案？
答案：【填写选择依据、替代方案和取舍】

问题：关键参数是多少，如何验证？
答案：【填写数值、单位、条件、来源文件和测量方法】

问题：项目中遇到的困难是什么，如何解决？
答案：【填写真实的现象、排查、根因、方案、结果】
`;
export function downloadProjectTemplate(kind: "overview" | "qa"): void {
  const url = URL.createObjectURL(new Blob([kind === "overview" ? PROJECT_OVERVIEW_TEMPLATE : PROJECT_QA_TEMPLATE], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = kind === "overview" ? "项目说明-填写模板.md" : "项目题库-填写模板.md"; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
export function ProjectFileGuide(): JSX.Element {
  return <div className="project-file-guide"><p><strong>先准备一份项目说明，再补关键代码。</strong>不需要把整个电脑的文件都上传。</p><ul>
    <li><b>项目说明 / 设计 / 调试 / 测试报告：</b>MD、TXT、DOCX、可提取文字的 PDF。</li>
    <li><b>源码：</b>压缩成 ZIP，保留 README、配置和关键源文件；删除编译产物、依赖目录、密钥和无关文件。</li>
    <li><b>已有面试问答：</b>去“项目题库 → 上传项目题库”，按“问题 / 答案”成对编写，不要混在源码入口。</li>
    <li><b>扫描版 PDF / 图片 / 视频 / EXE / RAR：</b>先整理成文字或 ZIP。图片里的参数请手动核对转录。</li>
  </ul></div>;
}
export function ProjectQuickStart(props: { hasProject: boolean; sourceCount?: number; trustedFacts?: number; onCreate: () => void; onUpload?: () => void; onReview?: () => void; onQuestions?: () => void }): JSX.Element {
  return <details className="project-quick-start" open={!props.hasProject || props.sourceCount === 0 ? true : undefined}>
    <summary><span>项目库怎么用？</span><small>上传什么 · 如何让回答有依据 · 怎样测试</small></summary>
    <p className="project-guide-lead">项目库不是上传完就自动可信。最快的路径是：先整理真实资料，再确认答案，最后用自己的问法测试。</p>
    <ol className="project-guide-steps">
      <li><span>01</span><div><strong>建立项目</strong><p>一个项目一个资料空间，选清个人、团队或参考项目。</p></div><button onClick={props.onCreate}>{props.hasProject ? "新建另一个" : "创建项目"}</button></li>
      <li><span>02</span><div><strong>上传并分析</strong><p>{props.sourceCount ? `已有 ${props.sourceCount} 份资料。` : "推荐：项目说明 + 关键源码 ZIP。"}参数、职责、取舍、测试结果越具体越好。</p></div><button disabled={!props.hasProject} onClick={props.onUpload}>添加资料</button></li>
      <li><span>03</span><div><strong>核对事实与来源</strong><p>逐条查看原文，确认数值、单位和自己的职责；冲突先处理。{props.trustedFacts ? `当前有 ${props.trustedFacts} 条可信信息。` : ""}</p></div><button disabled={!props.hasProject} onClick={props.onReview}>查看待确认</button></li>
      <li><span>04</span><div><strong>准备答案并自测</strong><p>导入已有问答或生成草稿，确认问题和答案，再用原问法、同义问法、无资料问题各测一次。</p></div><button disabled={!props.hasProject} onClick={props.onQuestions}>题库与自测</button></li>
    </ol>
    <ProjectFileGuide />
    <div className="project-guide-downloads"><button onClick={() => downloadProjectTemplate("overview")}>下载项目说明模板</button><button onClick={() => downloadProjectTemplate("qa")}>下载问答模板</button></div>
    <p className="project-guide-note">验收标准：命中正确项目、答案与真实资料一致；无依据的问题应提示资料不足。开始面试时选择这个项目；如果未选，自动识别仍可能有歧义。“匹配自测”不调用模型，不等于最终回答准确率。</p>
  </details>;
}
