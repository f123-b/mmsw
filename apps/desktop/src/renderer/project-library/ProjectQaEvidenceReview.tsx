import { useMemo, useState } from "react";
import type { JSX } from "react";
import { auditProjectQaEvidence, isFactEligible, planAnswerSource, StrictProjectQaRouter, type ProjectFact, type QuestionBankQuestionRecord } from "@interview-copilot/shared";
import "./project-qa-evidence.css";

export function ProjectQaEvidenceReview(props: { projectId: string; answer: string; factIds: string[]; facts: ProjectFact[]; sourceTitle?: (sourceId: string) => string }): JSX.Element {
  const audit = useMemo(() => auditProjectQaEvidence(props), [props.projectId, props.answer, props.factIds, props.facts]);
  const linked = props.factIds.map((id) => props.facts.find((fact) => fact.id === id && fact.projectId === props.projectId)).filter((fact): fact is ProjectFact => Boolean(fact));
  return <details className={`project-qa-evidence ${audit.blocked ? "has-risk" : ""}`}>
    <summary>核验与来源 · {audit.blocked ? `${audit.issues.length} 项风险需处理` : linked.length ? `${linked.length} 条关联事实` : "待补充依据"}</summary>
    <p className="project-qa-review-note">自动检查仅提示风险，不代表答案已被证实。请逐句核对技术含义、职责范围和测量条件。</p>
    {audit.issues.length > 0 && <ul>{audit.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.sentence && <blockquote>{issue.sentence}</blockquote>}</li>)}</ul>}
    {linked.map((fact) => <div className="project-qa-fact-evidence" key={fact.id}>
      <strong>{fact.title} · {isFactEligible(fact) ? "可用事实" : "不可用事实"}</strong>
      <p>{fact.content}</p>
      {fact.evidence?.map((item, index) => <blockquote key={`${item.sourceId}-${index}`}><small>{props.sourceTitle?.(item.sourceId) ?? item.sourceId}{item.locator ? ` · ${item.locator}` : ""}{item.relation === "refute" ? " · 反证" : ""}</small><p>{item.quote}</p></blockquote>)}
    </div>)}
  </details>;
}

export function ProjectQaMatchCheck(props: { projectId: string; questions: QuestionBankQuestionRecord[] }): JSX.Element {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const result = useMemo(() => {
    if (!submitted.trim()) return undefined;
    const strict = new StrictProjectQaRouter().match(submitted, props.questions, props.projectId);
    const plan = planAnswerSource({ projectId: props.projectId, projectQuestion: true, strictProjectQa: true, projectQa: strict.route });
    const card = strict.route.top?.question.answerCards.find(card => card.verified && !card.stale);
    const answer = card ? [card.content, card.codeContent && `代码：\n${card.codeContent}`, card.complexity && `复杂度：${card.complexity}`, card.limitations && `边界与限制：${card.limitations}`].filter(Boolean).join("\n") : "";
    return { hit: strict.route.top, accepted: plan.mode === "project_qa_direct", answer };
  }, [submitted, props.projectId, props.questions]);
  return <details className="project-qa-match-check" open>
    <summary>测试项目库 · 查看实际会命中的答案（不调用 AI）</summary>
    <p>输入面试官的实际问法，检查能否命中当前项目已确认答案。仅测试严格题库匹配，不代表最终回答准确率。</p>
    <p>建议依次测试：① 原始问法，应命中；② 同一含义的另一种说法，未命中时增加相似问法；③ 资料中没有的问题，应提示未命中，不能编造答案。</p>
    {props.questions.length > 0 && <div className="project-qa-test-examples"><span>先试一道：</span>{props.questions.slice(0, 3).map(question => <button key={question.id} type="button" onClick={() => { setInput(question.canonicalText); setSubmitted(question.canonicalText); }}>{question.canonicalText}</button>)}</div>}
    <form onSubmit={(event) => { event.preventDefault(); setSubmitted(input.trim()); }}>
      <label className="clean-field"><span>测试问法</span><input value={input} onChange={(event) => { setInput(event.target.value); setSubmitted(""); }} placeholder="例如：这里怎么保证采样实时性？" /></label>
      <button className="outline-pill" disabled={!input.trim()}>检查匹配</button>
    </form>
    {result && <div role="status" className="project-qa-match-result"><strong>{result.accepted ? "可命中已确认答案" : "未命中可直接使用的已确认答案"}</strong><p>{result.hit ? `最接近的问题：${result.hit.question.canonicalText}` : "当前项目没有相关候选，请补充问题及相似问法。"}</p>{!result.accepted && result.hit && <p>请检查问题和答案是否都已确认、资料是否过期，以及问法是否表达同一含义。</p>}</div>}
    {result?.accepted && result.hit && <div className="project-qa-test-answer"><strong>命中的已确认答案</strong><p>{result.answer}</p><small>还需自己核对：项目是否正确、数字和单位是否真实、个人职责是否准确。面试时仍会执行事实校验。</small></div>}
  </details>;
}
