// Operator-only historical reconciliation module. Neither reads nor writes
// production publisher SQLite. Never calls Google Flow or social platforms.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const mediaCache=new Map();
const sha=s=>createHash('sha256').update(s).digest('hex');
const okId=x=>/^[a-z0-9_-]{1,50}$/i.test(String(x||''));
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
const safeRead=(f,fallback)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return fallback}};
function safeDir(root,id){if(!okId(id))throw Error('Canal inválido');return path.join(path.resolve(root),id)}
function assignmentsPath(root,id){return path.join(safeDir(root,'assignments'),id+'.json')}
function store(root,id){
 const s=safeRead(assignmentsPath(root,id),{schema:1,channel:id,assignments:[],audit:[]});
 if(s?.schema!==1||!Array.isArray(s.assignments)||!Array.isArray(s.audit))throw Error('Archivo de asignaciones inválido; no sobrescribir');
 return s;
}
function atomicWrite(file,data){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
 try{fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(tmp,file)}
 finally{try{fs.rmSync(tmp,{force:true})}catch{}}
}
async function videos(root,id){
 const dir=safeDir(root,id);
 if(!fs.existsSync(dir))return [];
 const files=fs.readdirSync(dir,{withFileTypes:true})
   .filter(e=>e.isFile()&&/\.mp4$/i.test(e.name))
   .map(e=>({name:e.name,full:path.join(dir,e.name)}))
   .map(e=>({...e,stat:fs.statSync(e.full)}))
   .sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).slice(0,250);
 const result=[];
 for(const f of files){
   if(f.stat.size<1000||f.stat.size>2*1024*1024*1024)continue;
   const real=fs.realpathSync(f.full);
   if(!real.startsWith(path.resolve(dir)+path.sep))continue;
   const cached=mediaCache.get(real);
   let hash=cached?.hash;
   if(!cached||cached.size!==f.stat.size||cached.mtimeMs!==f.stat.mtimeMs){
     const h=createHash('sha256');
     for await (const chunk of fs.createReadStream(real,{highWaterMark:1024*1024}))h.update(chunk);
     hash=h.digest('hex');
     mediaCache.set(real,{hash,size:f.stat.size,mtimeMs:f.stat.mtimeMs});
   }
   result.push({hash,name:f.name,size:f.stat.size,mtime:new Date(f.stat.mtimeMs).toISOString(),file:real});
 }
 return result;
}
function posts(root,id){
 const raw=safeRead(path.join(safeDir(root,'posts'),id+'.json'),[]);
 const rows=Array.isArray(raw)?raw:Array.isArray(raw?.posts)?raw.posts:[];
 return rows.filter(x=>x&&typeof x==='object').slice(-100).reverse().map((p,i)=>({
   id:String(p.id||p.post_id||'source-'+i).slice(0,150),
   timestamp:String(p.published_at||p.created_at||p.timestamp||'').slice(0,80),
   title:String(p.title||'').slice(0,350),
   prompt:String(p.flow_prompt||p.prompt||'').slice(0,80000),
   description:String(p.description||p.caption||'').slice(0,8000),
   provenance:'historical-source-unverified'
 }));
}
async function readBody(req,max=115000){
 let raw='';for await(const part of req){raw+=String(part);if(Buffer.byteLength(raw)>max)throw Error('Solicitud demasiado extensa')}
 try{return JSON.parse(raw)}catch{throw Error('JSON inválido')}
}
function originOk(req){
 const origin=String(req.headers.origin||'');if(!origin)return true;
 try{return new URL(origin).host===String(req.headers.host||'')}catch{return false}
}
export async function handleReconciliation(req,res,{channels=[],mediaRoot='/data/reconciliation-media',storeRoot='/data/reconciliation'}={}){
 const u=new URL(String(req.url||''),'http://localhost');
 if(!u.pathname.startsWith('/reconciliation'))return false;
 const id=String(u.searchParams.get('channel')||channels[0]?.id||'');
 if(!channels.some(c=>c.id===id)){json(res,404,{error:'Canal no configurado'});return true}
 try{
   if(req.method==='GET'&&u.pathname==='/reconciliation'){
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
     res.end(fs.readFileSync(path.join(process.cwd(),'public','reconciliation.html'),'utf8'));return true;
   }
   if(req.method==='GET'&&u.pathname==='/reconciliation/api/channels'){
     json(res,200,{channels:channels.map(c=>({id:c.id,name:c.name}))});return true;
   }
   if(req.method==='GET'&&u.pathname==='/reconciliation/api/videos'){
     const list=await videos(mediaRoot,id);
     json(res,200,{channel:id,videos:list.map(({file,...row})=>row)});return true;
   }
   if(req.method==='GET'&&u.pathname==='/reconciliation/api/posts'){
     json(res,200,{channel:id,posts:posts(storeRoot,id)});return true;
   }
   if(req.method==='GET'&&u.pathname==='/reconciliation/api/assignments'){
     json(res,200,{channel:id,assignments:store(storeRoot,id).assignments});return true;
   }
   if(req.method==='GET'&&u.pathname==='/reconciliation/api/video'){
     const hash=String(u.searchParams.get('hash')||'');
     if(!/^[a-f0-9]{64}$/.test(hash)){json(res,400,{error:'Hash inválido'});return true}
     const row=(await videos(mediaRoot,id)).find(x=>x.hash===hash);
     if(!row){json(res,404,{error:'Video no encontrado'});return true}
     const raw=String(req.headers.range||'');let from=0,to=row.size-1,status=200;
     if(raw){
       const m=/^bytes=(\d+)-(\d*)$/.exec(raw);
       if(!m){res.writeHead(416,{'Content-Range':'bytes */'+row.size});res.end();return true}
       from=Number(m[1]);to=m[2]?Number(m[2]):Math.min(row.size-1,from+8*1024*1024-1);
       if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>to||to>=row.size){
         res.writeHead(416,{'Content-Range':'bytes */'+row.size});res.end();return true
       }
       status=206;
     }
     res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes',
       'Cache-Control':'private,no-store','Content-Length':String(to-from+1),
       ...(status===206?{'Content-Range':'bytes '+from+'-'+to+'/'+row.size}:{})});
     fs.createReadStream(row.file,{start:from,end:to}).pipe(res);return true;
   }
   if(req.method==='POST'&&u.pathname==='/reconciliation/api/assign'){
     if(!originOk(req)||req.headers['x-reconciliation-operator']!=='manual-verified'){json(res,403,{error:'Verificación manual requerida'});return true}
     if(!String(req.headers['content-type']||'').startsWith('application/json')){json(res,415,{error:'JSON requerido'});return true}
     const data=await readBody(req);
     const hash=String(data.videoHash||''),season=Number(data.season),episode=Number(data.episode),prompt=data.flowPrompt;
     if(data.channel!==id||!/^[a-f0-9]{64}$/.test(hash)||!Number.isInteger(season)||season<1||season>99||
        !Number.isInteger(episode)||episode<1||episode>9999||typeof prompt!=='string'||prompt.trim().length<20||prompt.length>80000){
       json(res,400,{error:'Temporada, episodio, video o prompt exacto inválidos'});return true
     }
     if(!(await videos(mediaRoot,id)).some(x=>x.hash===hash)){json(res,404,{error:'El MP4 ya no está disponible'});return true}
     const state=store(storeRoot,id);
     if(state.assignments.some(x=>x.season===season&&x.episode===episode&&x.videoHash!==hash)){
       json(res,409,{error:'Esa temporada y episodio ya corresponden a otro video'});return true
     }
     const at=new Date().toISOString();
     const row={videoHash:hash,season,episode,flowPrompt:prompt,flowPromptSha256:sha(prompt),
       sourcePostId:data.sourcePostId?String(data.sourcePostId).slice(0,150):null,verifiedAt:at,
       provenance:'operator-verified-exact-prompt',metadataState:'pending-canonical-copy-review'};
     const existing=state.assignments.find(x=>x.videoHash===hash);
     state.assignments=state.assignments.filter(x=>x.videoHash!==hash).concat(row);
     const prevHash=state.audit.at(-1)?.recordHash||'0'.repeat(64);
     const audit={at,action:existing?'edited':'created',channel:id,videoHash:hash,
       season,episode,flowPromptSha256:row.flowPromptSha256,previousRecordHash:prevHash};
     audit.recordHash=sha(prevHash+JSON.stringify(audit));
     state.audit.push(audit);
     atomicWrite(assignmentsPath(storeRoot,id),state);
     json(res,200,{ok:true,assignments:state.assignments});return true;
   }
   json(res,404,{error:'Ruta de conciliación desconocida'});return true;
 }catch(e){json(res,400,{error:String(e?.message||e).slice(0,320)});return true}
}
