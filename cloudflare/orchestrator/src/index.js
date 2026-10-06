const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const iso=()=>new Date().toISOString();
const enc=new TextEncoder();

function fmtDay(date,tz){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const o=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return o.year+"-"+o.month+"-"+o.day;
}
function uuid(){return crypto.randomUUID()}
async function hmac(secret,text){
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(text));
  return [...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function timingSafeHex(a,b){
  a=String(a||"");b=String(b||"");if(a.length!==b.length)return false;
  let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;
}
async function runnerAuth(req,env){
  const auth=String(req.headers.get("authorization")||"");
  return auth==="Bearer "+String(env.RUNNER_SHARED_SECRET||"");
}
async function signedBody(req,env){
  const body=await req.text();
  const provided=String(req.headers.get("x-publisher-signature")||"");
  const expected=await hmac(String(env.RUNNER_SHARED_SECRET||""),body);
  if(!timingSafeHex(provided,expected))throw new Error("BAD_SIGNATURE");
  return {body,data:JSON.parse(body||"{}")};
}
async function ensureToday(env,p){
  const day=fmtDay(new Date(),p.timezone||"America/Argentina/Buenos_Aires");
  const now=iso();
  const statements=[];
  for(let i=1;i<=Number(p.generation_target||3);i++){
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO obligations(id,publisher_id,local_day,kind,ordinal,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)"
    ).bind(uuid(),p.id,day,"generation",i,now,now));
  }
  for(let i=1;i<=Number(p.publication_target||1);i++){
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO obligations(id,publisher_id,local_day,kind,ordinal,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)"
    ).bind(uuid(),p.id,day,"publication",i,now,now));
  }
  if(statements.length)await env.DB.batch(statements);
}
async function reapExpiredLeases(env){
  const now=iso();
  await env.DB.prepare(
    "UPDATE obligations SET status='pending',lease_until=NULL,last_error=COALESCE(last_error,'RUNNER_LEASE_EXPIRED'),updated_at=? WHERE status IN ('dispatching','dispatched','running') AND lease_until IS NOT NULL AND lease_until<?"
  ).bind(now,now).run();
}
async function dispatchGithub(env,p,o){
  const leaseMinutes=Math.max(15,Math.min(120,Number(env.LEASE_MINUTES||45)));
  const leaseUntil=new Date(Date.now()+leaseMinutes*60000).toISOString();
  const claim=await env.DB.prepare(
    "UPDATE obligations SET status='dispatching',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'"
  ).bind(leaseUntil,iso(),o.id).run();
  if(!claim.meta?.changes)return false;

  const repo=String(p.github_repo||env.GITHUB_REPO||"fruttidrama-afk/Frutti-Drama-Publisher");
  const workflow=String(p.github_workflow||env.GITHUB_WORKFLOW||"free-runtime-runner.yml");
  const ref=String(env.GITHUB_REF||"main");
  const r=await fetch("https://api.github.com/repos/"+repo+"/actions/workflows/"+encodeURIComponent(workflow)+"/dispatches",{
    method:"POST",
    headers:{
      "authorization":"Bearer "+String(env.GITHUB_TOKEN||""),
      "accept":"application/vnd.github+json",
      "x-github-api-version":"2022-11-28",
      "content-type":"application/json",
      "user-agent":"PublisherFactory-Orchestrator/1.0"
    },
    body:JSON.stringify({ref,inputs:{
      publisher_id:String(p.id),
      obligation_id:String(o.id),
      kind:String(o.kind),
      local_day:String(o.local_day),
      ordinal:String(o.ordinal)
    }})
  });
  if(!r.ok){
    const detail=(await r.text()).slice(0,700);
    await env.DB.prepare("UPDATE obligations SET status='pending',lease_until=NULL,last_error=?,updated_at=? WHERE id=?")
      .bind("GITHUB_DISPATCH_"+r.status+": "+detail,iso(),o.id).run();
    throw new Error("GITHUB_DISPATCH_"+r.status);
  }
  await env.DB.prepare("UPDATE obligations SET status='dispatched',updated_at=? WHERE id=?").bind(iso(),o.id).run();
  return true;
}
async function dispatchDue(env){
  const pubs=(await env.DB.prepare("SELECT * FROM publishers WHERE enabled=1 ORDER BY id").all()).results||[];
  for(const p of pubs){
    await ensureToday(env,p);
    const activeGen=await env.DB.prepare("SELECT id FROM obligations WHERE publisher_id=? AND kind='generation' AND status IN ('dispatching','dispatched','running') LIMIT 1").bind(p.id).first();
    if(!activeGen){
      const o=await env.DB.prepare("SELECT * FROM obligations WHERE publisher_id=? AND kind='generation' AND status='pending' ORDER BY local_day,ordinal LIMIT 1").bind(p.id).first();
      if(o)await dispatchGithub(env,p,o);
    }

    const activePub=await env.DB.prepare("SELECT id FROM obligations WHERE publisher_id=? AND kind='publication' AND status IN ('dispatching','dispatched','running') LIMIT 1").bind(p.id).first();
    if(!activePub&&Number(p.approved_stock||0)>0){
      const o=await env.DB.prepare("SELECT * FROM obligations WHERE publisher_id=? AND kind='publication' AND status='pending' ORDER BY local_day,ordinal LIMIT 1").bind(p.id).first();
      if(o)await dispatchGithub(env,p,o);
    }
  }
}
async function cron(env){
  await reapExpiredLeases(env);
  await dispatchDue(env);
}
async function callback(req,env){
  const {data}=await signedBody(req,env);
  const id=String(data.obligation_id||"");
  if(!id)return json({error:"obligation_id required"},400);
  const o=await env.DB.prepare("SELECT * FROM obligations WHERE id=?").bind(id).first();
  if(!o)return json({error:"obligation not found"},404);
  const status=String(data.status||"failed");
  if(!["running","completed","blocked","failed"].includes(status))return json({error:"invalid status"},400);
  const err=data.error?String(data.error).slice(0,1200):null;
  await env.DB.prepare("UPDATE obligations SET status=?,lease_until=?,last_error=?,updated_at=? WHERE id=?")
    .bind(status,status==="running"?new Date(Date.now()+45*60000).toISOString():null,err,iso(),id).run();

  const stock=Number.isFinite(Number(data.approved_stock))?Math.max(0,Number(data.approved_stock)):null;
  const fields=[];
  if(status==="completed"&&o.kind==="generation")fields.push("last_generation_at='"+iso().replaceAll("'","''")+"'");
  if(status==="completed"&&o.kind==="publication")fields.push("last_publication_at='"+iso().replaceAll("'","''")+"'");
  if(stock!==null)fields.push("approved_stock="+Math.floor(stock));
  fields.push("last_runner_at='"+iso().replaceAll("'","''")+"'");
  fields.push("last_error="+(err?"'"+err.replaceAll("'","''")+"'":"NULL"));
  fields.push("updated_at='"+iso().replaceAll("'","''")+"'");
  await env.DB.prepare("UPDATE publishers SET "+fields.join(",")+" WHERE id=?").bind(o.publisher_id).run();
  return json({ok:true});
}
async function job(req,env,id){
  if(!await runnerAuth(req,env))return json({error:"unauthorized"},401);
  const o=await env.DB.prepare("SELECT * FROM obligations WHERE id=?").bind(id).first();
  if(!o)return json({error:"not found"},404);
  const p=await env.DB.prepare("SELECT * FROM publishers WHERE id=?").bind(o.publisher_id).first();
  if(!p)return json({error:"publisher not found"},404);
  await env.DB.prepare("UPDATE obligations SET status='running',lease_until=?,updated_at=? WHERE id=?")
    .bind(new Date(Date.now()+45*60000).toISOString(),iso(),id).run();
  let cfg={};try{cfg=JSON.parse(p.config_json||"{}")}catch{}
  return json({publisher:{...p,config:cfg,config_json:undefined},obligation:o});
}
async function blob(req,env,publisherId,type){
  if(!await runnerAuth(req,env))return json({error:"unauthorized"},401);
  if(!["state","profile"].includes(type))return json({error:"invalid blob type"},400);
  const key="publishers/"+publisherId+"/"+type+".tgz.enc";
  if(req.method==="GET"){
    const obj=await env.MEDIA.get(key);
    if(!obj)return new Response(null,{status:404});
    return new Response(obj.body,{headers:{"content-type":"application/octet-stream","etag":obj.httpEtag||""}});
  }
  if(req.method==="PUT"){
    const etag=req.headers.get("if-match");
    const current=await env.MEDIA.head(key);
    if(etag&&current&&current.httpEtag!==etag)return json({error:"etag mismatch"},412);
    const put=await env.MEDIA.put(key,req.body,{httpMetadata:{contentType:"application/octet-stream"}});
    return json({ok:true,etag:put.httpEtag||null});
  }
  return json({error:"method not allowed"},405);
}
async function health(env){
  const publishers=Number((await env.DB.prepare("SELECT COUNT(*) n FROM publishers WHERE enabled=1").first())?.n||0);
  const pending=Number((await env.DB.prepare("SELECT COUNT(*) n FROM obligations WHERE status='pending'").first())?.n||0);
  const active=Number((await env.DB.prepare("SELECT COUNT(*) n FROM obligations WHERE status IN ('dispatching','dispatched','running')").first())?.n||0);
  const failed=Number((await env.DB.prepare("SELECT COUNT(*) n FROM obligations WHERE status IN ('blocked','failed')").first())?.n||0);
  return json({ok:true,version:"free-runtime-orchestrator-v1",at:iso(),publishers,pending,active,failed});
}

export default{
  async scheduled(_event,env,ctx){ctx.waitUntil(cron(env))},
  async fetch(req,env){
    const u=new URL(req.url);
    if(u.pathname==="/health"&&req.method==="GET")return health(env);
    if(u.pathname==="/callback"&&req.method==="POST")return callback(req,env);
    const jm=u.pathname.match(/^\/job\/([^/]+)$/);if(jm&&req.method==="GET")return job(req,env,decodeURIComponent(jm[1]));
    const bm=u.pathname.match(/^\/blob\/(state|profile)\/([^/]+)$/);if(bm)return blob(req,env,decodeURIComponent(bm[2]),bm[1]);
    if(u.pathname==="/tick"&&req.method==="POST"){
      if(!await runnerAuth(req,env))return json({error:"unauthorized"},401);
      await cron(env);return json({ok:true});
    }
    return json({error:"not found"},404);
  }
};
