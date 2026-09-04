import {describe,it,expect,vi,afterEach} from 'vitest';
import {installNonActivatingInput} from './nonactivating-input';
function fixture(){
  const handlers=new Map<string,(event:unknown)=>void>();
  const button={disabled:false,isConnected:true,click:vi.fn(),getAttribute:()=>null,closest:()=>button,contains:(target:unknown)=>target===button};
  const root={documentElement:{},addEventListener:(type:string,handler:(event:unknown)=>void)=>handlers.set(type,handler),removeEventListener:()=>{},defaultView:new EventTarget()};
  const cleanup=installNonActivatingInput(root as unknown as Document);
  return {button,root,cleanup,fire:(type:string,patch:Record<string,unknown>={})=>handlers.get(type)?.({target:button,isTrusted:true,button:0,pointerType:'mouse',...patch})};
}
afterEach(()=>vi.useRealTimers());
describe('non-activating Windows input recovery',()=>{
  it('recovers a swallowed press exactly once',async()=>{vi.useFakeTimers();const f=fixture();f.fire('pointerup');await vi.runAllTimersAsync();expect(f.button.click).toHaveBeenCalledOnce();f.cleanup();});
  it('does not duplicate a normal click',async()=>{vi.useFakeTimers();const f=fixture();f.fire('pointerdown');f.fire('pointerup');f.fire('click');await vi.runAllTimersAsync();expect(f.button.click).not.toHaveBeenCalled();f.cleanup();});
  it('cancels recovery when Chromium supplies its own click',async()=>{vi.useFakeTimers();const f=fixture();f.fire('pointerup');f.fire('click');await vi.runAllTimersAsync();expect(f.button.click).not.toHaveBeenCalled();f.cleanup();});
  it('suppresses a late native click after recovery but accepts a new gesture',async()=>{vi.useFakeTimers();const f=fixture();const preventDefault=vi.fn(),stopImmediatePropagation=vi.fn();f.fire('pointerup');await vi.advanceTimersByTimeAsync(60);f.fire('click',{preventDefault,stopImmediatePropagation});expect(stopImmediatePropagation).toHaveBeenCalledOnce();f.fire('pointerup');await vi.advanceTimersByTimeAsync(60);expect(f.button.click).toHaveBeenCalledTimes(2);f.cleanup();});
  it('does not click a disabled button or a drag entering from outside',async()=>{vi.useFakeTimers();const f=fixture();f.button.disabled=true;f.fire('pointerup');f.button.disabled=false;f.fire('pointerenter',{target:f.root.documentElement,buttons:1});f.fire('pointerup');await vi.runAllTimersAsync();expect(f.button.click).not.toHaveBeenCalled();f.cleanup();});
});
