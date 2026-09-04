import {describe,it,expect} from 'vitest';
import {planAnswerSource, withGroundedProjectFallback, type KnowledgeChunk} from '@interview-copilot/shared';
import {scopedProjectEvidence, projectResumeEvidence} from './project-grounding';
describe('project document fallback',()=>{
  const document=(projectId:string,scope='project'):KnowledgeChunk=>({id:'doc',text:'FOC 项目使用 STM32F405 主控和三相电流采样，闭环控制电机。',metadata:{documentId:'source',filename:'FOC说明.md',projectId,scope} as KnowledgeChunk['metadata']});
  const plan=planAnswerSource({projectId:'foc',projectQuestion:true,strictProjectQa:true});
  it('uses an uploaded project document without requiring a curated Q&A',()=>{
    const evidence=scopedProjectEvidence('foc',[document('foc')]);
    expect(evidence[0]).toContain('source');expect(withGroundedProjectFallback(plan,evidence)).toMatchObject({mode:'project_knowledge_generated',allowGeneralKnowledge:false});
  });
  it('excludes other projects, generic references and bare names',()=>{
    expect(scopedProjectEvidence('foc',[document('other'),document('foc','global-reference'),{...document('foc'),text:'FOC'}])).toEqual([]);
    expect(withGroundedProjectFallback(plan,[]).mode).toBe('project_qa_no_match');
  });
  it('uses only resume excerpts mentioning the selected project',()=>expect(projectResumeEvidence(['Resume: FOC 项目中负责采样驱动开发。','Resume: ESP32 蓝牙系统。'],['基于STM32的FOC控制'])).toEqual(['Resume: FOC 项目中负责采样驱动开发。']));
});
