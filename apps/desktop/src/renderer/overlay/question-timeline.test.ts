import {describe,it,expect} from 'vitest';
import {upsertTimelineGroup} from './question-timeline';
import {buildAnswerOverlayViewModel} from './view-models';
describe('question timeline',()=>{
  const group=(id:string)=>({id,items:[{questionId:id,text:id,answerable:true,state:'queued'}]});
  it('keeps an old unanswered question before newer answers',()=>{
    let groups=upsertTimelineGroup([],group('old'));groups=upsertTimelineGroup(groups,group('new'));groups=upsertTimelineGroup(groups,group('old'));
    const view=buildAnswerOverlayViewModel([{groupId:'new',questionId:'new',title:'new',createdAt:2,updatedAt:2,answers:[{answerId:'a',questionId:'new',groupId:'new',questionText:'new',answerText:'answer',status:'complete',visible:true,relation:'PRIMARY',startedAt:2}]}],undefined,undefined,'',false,groups,{old:'没有证据'});
    expect(view.items.map(item=>item.questionId)).toEqual(['old','new']);expect(view.items[0].status).toBe('blocked');
  });
  it('puts a new follow-up in an old group after questions already received',()=>{
    let groups=upsertTimelineGroup([],group('a'));groups=upsertTimelineGroup(groups,group('b'));
    groups=upsertTimelineGroup(groups,{id:'a',items:[...group('a').items,...group('followup').items]});
    const view=buildAnswerOverlayViewModel([],undefined,undefined,'',false,groups);
    expect(view.items.map(item=>item.questionId)).toEqual(['a','b','followup']);
  });
});
