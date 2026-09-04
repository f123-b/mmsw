import {describe,it,expect,vi,afterEach} from 'vitest';
import {OpenAICompatibleAnswerProvider, buildLlmHttpRequest, providerEndpoint, type LlmApiProtocol, type ProviderSettings} from './providers';
const settings: ProviderSettings = {providerName:'fixture',baseUrl:'https://fixture.test/v1',model:'test',apiKey:'fixture-key',timeoutMs:1000,maxRetries:0};
const request = {model:'test',sections:[{name:'question' as const,content:'hello'}]};
const consume = async (provider: OpenAICompatibleAnswerProvider, signal?: AbortSignal) => {let text='';for await(const delta of provider.stream(request,signal)) text+=delta;return text;};
afterEach(()=>vi.useRealTimers());
describe('mainstream LLM protocol contract',()=>{
  it.each([
    ['openai-chat',{choices:[{delta:{content:'你好'}}]},{choices:[{finish_reason:'stop'}]},{choices:[{message:{content:'你好'}}]},'chat/completions'],
    ['openai-responses',{type:'response.output_text.delta',delta:'你好'},{type:'response.completed'},{output:[{type:'message',content:[{type:'output_text',text:'你好'}]}]},'responses'],
    ['anthropic-messages',{type:'content_block_delta',delta:{type:'text_delta',text:'你好'}},{type:'message_stop'},{content:[{type:'text',text:'你好'}]},'messages']
  ] as const)('%s streams and completes with the correct contract',async(protocol,delta,done,json,path)=>{
    const calls: Array<{url:string;init?:RequestInit}>=[];
    const provider = new OpenAICompatibleAnswerProvider({...settings,apiProtocol:protocol},async(url,init)=>{
      calls.push({url:String(url),init});
      if(JSON.parse(String(init?.body)).stream) return new Response(`event: update\ndata: ${JSON.stringify(delta)}\n\nevent: complete\ndata: ${JSON.stringify(done)}\n\n`,{headers:{'content-type':'text/event-stream'}});
      return Response.json(json);
    });
    expect(await consume(provider)).toBe('你好');expect(await provider.complete(request)).toBe('你好');
    expect(calls.every(call=>call.url===`https://fixture.test/v1/${path}`)).toBe(true);
    const headers=calls[0].init?.headers as Record<string,string>;
    if(protocol==='anthropic-messages'){expect(headers['x-api-key']).toBe('fixture-key');expect(headers.authorization).toBeUndefined();expect(JSON.parse(String(calls[0].init?.body)).max_tokens).toBe(4096);}
    else expect(headers.authorization).toBe('Bearer fixture-key');
  });
  it.each(['openai-chat','openai-responses','anthropic-messages'] as LlmApiProtocol[])('preserves image input for %s',protocol=>{
    const http=buildLlmHttpRequest({...settings,apiProtocol:protocol},{...request,attachments:[{mimeType:'image/png',dataUrl:'data:image/png;base64,YWJj'}],maxOutputTokens:100},true);
    expect(JSON.stringify(http.body)).toContain('YWJj');
    if(protocol==='openai-responses'){expect(http.body.store).toBe(false);expect(http.body.max_output_tokens).toBe(100);expect(http.body.messages).toBeUndefined();}
    if(protocol==='anthropic-messages'){expect(http.body.max_tokens).toBe(100);expect(JSON.stringify(http.body)).toContain('media_type');}
  });
  it.each(['https://generativelanguage.googleapis.com/v1beta/openai','https://ark.cn-beijing.volces.com/api/v3','https://dashscope.aliyuncs.com/compatible-mode/v1','https://gateway.test/custom-prefix'])('does not corrupt supplied API prefixes: %s',baseUrl=>expect(providerEndpoint({...settings,baseUrl},'v1/chat/completions')).toBe(`${baseUrl}/chat/completions`));
  it('uses completion-token budget for OpenAI reasoning models',()=>expect(buildLlmHttpRequest(settings,{...request,model:'gpt-5',maxOutputTokens:500},true).body).toMatchObject({max_completion_tokens:500}));
  it('aborts a stalled stream and releases its reader',async()=>{
    const cancel=vi.fn();const provider=new OpenAICompatibleAnswerProvider(settings,async()=>new Response(new ReadableStream({cancel})));
    const controller=new AbortController();const pending=consume(provider,controller.signal);const assertion=expect(pending).rejects.toMatchObject({name:'AbortError'});
    await Promise.resolve();await Promise.resolve();controller.abort();await assertion;expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds a fetch implementation that ignores abort',async()=>{
    vi.useFakeTimers();const provider=new OpenAICompatibleAnswerProvider(settings,()=>new Promise(()=>{}));
    const pending=expect(consume(provider)).rejects.toMatchObject({name:'TimeoutError'});await vi.advanceTimersByTimeAsync(1001);await pending;
  });
  it('does not retry invalid credentials',async()=>{
    const fetch=vi.fn(async()=>new Response('invalid',{status:401}));const provider=new OpenAICompatibleAnswerProvider({...settings,maxRetries:3},fetch);
    await expect(consume(provider)).rejects.toThrow('401');expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([{type:'error',error:{message:'overloaded'}},{type:'response.failed',response:{error:{message:'failed'}}},{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}}])('reports streaming failures instead of empty success',async(event)=>{
    const provider=new OpenAICompatibleAnswerProvider(settings,async()=>new Response(`data: ${JSON.stringify(event)}\n\n`));await expect(consume(provider)).rejects.toThrow('Provider response failed');
  });
});
