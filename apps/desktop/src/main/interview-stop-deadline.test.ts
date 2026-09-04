import {EventEmitter} from 'node:events';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {AnswerAgent,ModelRouter,SessionStateMachine} from '@interview-copilot/shared';
import {InterviewCoordinator} from './interview-coordinator';
class Audio extends EventEmitter {start(){} stop=vi.fn(()=>new Promise<void>(()=>{}));}
class Realtime extends EventEmitter {connect(){this.emit('state','connected');} disconnect=vi.fn();sendAudio(){}sendControl(){}finalize(){return new Promise<void>(()=>{});}}
afterEach(()=>vi.useRealTimers());
describe('interview stop deadline',()=>{
  it('cancels a pending startup before it can reconnect ASR or open capture',async()=>{
    let ready!:()=>void;
    const audio=Object.assign(new Audio(),{waitForIdle:()=>new Promise<void>(resolve=>{ready=resolve;}),start:vi.fn(),stop:vi.fn(async()=>{})});
    const realtime=Object.assign(new Realtime(),{connect:vi.fn(),finalize:async()=>{}});
    const coordinator=new InterviewCoordinator({audio,realtime,session:new SessionStateMachine(),answerAgent:new AnswerAgent({'low-latency':{stream:async function*(){yield 'fixture';}}},new ModelRouter({'low-latency':'fixture'}))});
    const start=coordinator.start({profileId:'fixture',url:'wss://fixture.test',answerMode:'NORMAL'}).catch(error=>error);
    await coordinator.stop();ready();await start;
    expect(audio.start).not.toHaveBeenCalled();expect(realtime.connect).not.toHaveBeenCalled();expect(coordinator.running).toBe(false);
  });
  it('stops capture immediately, bounds all cleanup once and permits restart',async()=>{
    vi.useFakeTimers();const audio=new Audio(),realtime=new Realtime();
    const coordinator=new InterviewCoordinator({audio,realtime,session:new SessionStateMachine(),stopTimeoutMs:500,answerAgent:new AnswerAgent({'low-latency':{stream:async function*(){yield 'fixture';}}},new ModelRouter({'low-latency':'fixture'}))});
    const options={profileId:'fixture',url:'wss://fixture.test',automationMode:'MANUAL' as const,answerMode:'NORMAL' as const};
    await coordinator.start(options);const first=coordinator.stop(),second=coordinator.stop();
    expect(audio.stop).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(501);await Promise.all([first,second]);expect(coordinator.running).toBe(false);expect(realtime.disconnect).toHaveBeenCalled();
    await coordinator.start(options);expect(coordinator.running).toBe(true);const again=coordinator.stop();await vi.advanceTimersByTimeAsync(501);await again;expect(coordinator.running).toBe(false);
  });
});
