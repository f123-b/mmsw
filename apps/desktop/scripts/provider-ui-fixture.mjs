// Isolated Playwright CLI fixture. All API responses are local, not live models.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=resolve(desktop,'../..');
const artifacts=join(root,'output/playwright',`provider-ui-${Date.now()}`);
await mkdir(artifacts,{recursive:true});
const requests=[];
let child;
const server=createServer(async(req,res)=>{
  if(req.url==='/_test/shutdown'){res.end('closing');setTimeout(()=>{child?.kill();server.close();},100);return;}
  if(req.url==='/_test/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({requests}));return;}
  let raw='';for await(const data of req)raw+=data;
  const body=raw?JSON.parse(raw):{};
  requests.push({path:req.url,model:body.model,stream:body.stream});
  res.setHeader('content-type','application/json');
  if(req.url?.endsWith('/models'))res.end(JSON.stringify({data:[{id:'fixture-text',object:'model'}]}));
  else if(req.url?.endsWith('/responses'))res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}));
  else if(req.url?.endsWith('/messages'))res.end(JSON.stringify({content:[{type:'text',text:'OK'}]}));
  else if(req.url?.endsWith('/chat/completions'))res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));
  else {res.statusCode=404;res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
const env={...process.env,INTERVIEW_COPILOT_DISABLE_GPU:'1',INTERVIEW_COPILOT_TEST_DATA_PATH:join(artifacts,'data')};delete env.ELECTRON_RUN_AS_NODE;
child=spawn(process.env.ELECTRON_EXECUTABLE??join(root,'node_modules/electron/dist/electron.exe'),['--disable-gpu','--in-process-gpu','--remote-debugging-port=9336',`--user-data-dir=${join(artifacts,'browser')}`,...(process.env.ELECTRON_PACKAGED==='true'?[]:[desktop])],{cwd:desktop,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=String(chunk);});
console.log(JSON.stringify({artifacts,endpoint,cdp:'http://127.0.0.1:9336',pid:child.pid}));
const timer=setTimeout(()=>{child.kill();server.close();},600000);
child.on('exit',async()=>{clearTimeout(timer);await writeFile(join(artifacts,'fixture.log'),output);await writeFile(join(artifacts,'requests.json'),JSON.stringify(requests,null,2));server.close();});
