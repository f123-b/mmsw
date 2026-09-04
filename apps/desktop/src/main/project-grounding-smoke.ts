import { chunkText, type AnswerContextInput } from '@interview-copilot/shared';
import type { SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectRepository, SqliteProjectMemoryRepository } from './database';
import type { InterviewContextSelection } from './interview-coordinator';

/** Runs against the actual application context provider with disposable SQLite
 * data. No model call, API key, microphone, or user profile is needed. */
export async function runProjectGroundingSmoke(options: {
  profiles: SqliteProfileRepository; projects: SqliteProjectRepository;
  memory: SqliteProjectMemoryRepository; knowledge: SqliteKnowledgeRepository;
  prepare: (key: {profileId:string;projectId?:string}) => void;
  context: (question:{text:string}, profileId:string, transcript:string[], selection:InterviewContextSelection) => Promise<AnswerContextInput>;
}) {
  if (!process.env.INTERVIEW_COPILOT_TEST_DATA_PATH) throw new Error('Disposable test profile required');
  const checks:string[]=[];
  const check=(condition:unknown,name:string)=>{if(!condition)throw new Error(`GROUNDING: ${name}`);checks.push(name);};
  const {profiles,projects,memory,knowledge}=options;
  const base=knowledge.createKnowledgeBase('grounding-regression');
  const profile=profiles.save({name:'FOC document regression',knowledgeBaseIds:[base.id],resume:{rawContent:'我在 BLDC 调速项目中负责 PWM 驱动和转速采样，完成了串口调试工具。',summary:'BLDC 调速项目中负责 PWM 驱动和转速采样。'}});
  const foc=projects.create('基于 STM32 的 FOC 电机控制',profile.id);
  const bldc=projects.create('BLDC 调速项目',profile.id);
  const empty=projects.create('空白待补充项目',profile.id);
  const text='FOC 项目使用 STM32F405 主控，通过 ADC 同步采集三相电流，使用 Clarke/Park 变换与电流 PI 闭环，通过 SVPWM 驱动逆变器。项目实测参数尚未记录，不得捏造转矩误差或个人职责。';
  const doc=knowledge.saveDocument({id:'grounding-foc-code',knowledgeBaseId:base.id,filename:'FOC-control.md',mimeType:'text/markdown',sha256:'fixture-foc-document',text,sections:[text],documentType:'project',status:'ready'});
  knowledge.replaceChunks(doc.id,chunkText(text,{documentId:doc.id,filename:doc.filename,documentType:'project'}));
  memory.assignSource({projectId:foc.id,sourceType:'document',sourceId:doc.id,relationship:'primary',sourceRole:'code',assignmentMethod:'explicit',confidence:1,verified:true});
  for(const contextMode of ['fast','rich'] as const){
    options.prepare({profileId:profile.id});
    const context=await options.context({text:'你来讲一下FOC项目'},profile.id,[],{contextMode,strictProjectQa:true});
    check(context.answerSourcePlan?.mode==='project_knowledge_generated' && context.answerSourcePlan.projectId===foc.id, `${contextMode}: spoken FOC resolves without a prepared Q&A`);
    check(context.projectEvidence?.some(item=>item.includes('STM32F405')&&item.includes('SVPWM')),`${contextMode}: bound code document reaches answer evidence`);
    check(context.answerSourcePlan?.allowGeneralKnowledge===false,`${contextMode}: does not substitute generic knowledge for project facts`);
    options.prepare({profileId:profile.id,projectId:bldc.id});
    const resume=await options.context({text:'介绍一下BLDC调速项目'},profile.id,[],{contextMode,strictProjectQa:true,projectId:bldc.id});
    check(resume.answerSourcePlan?.mode==='project_knowledge_generated' && resume.projectEvidence?.some(item=>item.includes('PWM')) && !resume.projectEvidence?.some(item=>item.includes('STM32F405')),`${contextMode}: resume-only project is grounded without cross-project facts`);
    options.prepare({profileId:profile.id,projectId:empty.id});
    const blocked=await options.context({text:'介绍一下空白待补充项目'},profile.id,[],{contextMode,strictProjectQa:true,projectId:empty.id});
    check(blocked.answerSourcePlan?.mode==='project_qa_no_match',`${contextMode}: bare project name is not fabricated evidence`);
    const general=await options.context({text:'DMA的原理是什么'},profile.id,[],{contextMode,strictProjectQa:true});
    check(!general.projectEvidence?.some(item=>item.includes('STM32F405')),`${contextMode}: technical question does not inherit unrelated project facts`);
  }
  return {ok:true,checks};
}
