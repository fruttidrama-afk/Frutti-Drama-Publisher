import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-state-repair';
const AUD='publisher-factory-frutti-state-repair';
const ROOT='/tmp/frutti-state-repair';
const TAR=ROOT+'/state.tgz';
const OUT=ROOT+'/state-fixed.tgz';

const episodes=[
  ['NUEVO COMIENZO','Después del memorial de Banana, Uva Reyes y Limón Duarte deciden darse una oportunidad real como pareja. Bananita los ve juntos y Uva siente por primera vez que puede empezar una nueva etapa.'],
  ['BESO INTERRUMPIDO','Uva Reyes y Limón Duarte se besan en el jardín de la hacienda. Fresia aparece inesperadamente, ve el beso y queda visiblemente afectada.'],
  ['CELOS DE FRESIA','Fresia enfrenta a Limón Duarte a solas y le recuerda que tienen un hijo en común. Limón deja claro que será un padre presente, pero que su relación sentimental con Fresia terminó.'],
  ['DUDA DE UVA','Uva Reyes escucha una parte de la conversación entre Fresia y Limón Duarte y teme volver a quedar atrapada en un triángulo amoroso. Limón intenta explicarle que eligió estar con ella.'],
  ['LÍMITE FINAL','Limón Duarte pone un límite definitivo a Fresia: pueden criar a su hijo juntos, pero no volverán a ser pareja. Fresia contiene la humillación y decide no mostrar cuánto le dolió.'],
  ['FRESIA CONTRAATACA','Fresia le dice a Uva Reyes que Limón siempre estará unido a ella por su hijo. Uva se niega a competir y le responde que la confianza se demuestra con hechos.'],
  ['PROMESA DE LIMÓN','Limón Duarte busca a Uva Reyes y le promete que no repetirá las mentiras del pasado. Uva acepta seguir con la relación, pero le exige transparencia absoluta.'],
  ['SECRETO ESCUCHADO','Don Melón escucha a Fresia admitir que todavía siente algo por Limón Duarte. Sin intervenir todavía, comprende que el nuevo equilibrio de la hacienda puede romperse.'],
  ['ADVERTENCIA DE MELÓN','Don Melón confronta a Fresia y le exige que no destruya la relación entre Uva Reyes y Limón Duarte. Fresia asegura que no hará nada, pero su expresión revela conflicto.'],
  ['CITA FAMILIAR','Uva Reyes, Limón Duarte y Bananita comparten una tarde tranquila en el jardín. La escena confirma que están formando una nueva familia mientras Fresia los observa desde lejos.'],
  ['CONFESIÓN DE FRESIA','Fresia admite frente a Uva Reyes que todavía tiene sentimientos por Limón Duarte. Uva no retrocede y le exige que respete la relación que Limón eligió.'],
  ['ELECCIÓN DEFINITIVA','Limón Duarte reafirma delante de Uva Reyes y Fresia que quiere construir su futuro con Uva. Fresia se queda sola con una decisión que puede cambiar la temporada.']
];
const flowEditIds=[
 'cce7c635-3009-4481-ac50-e7bd8d7d9587',
 '840d3fe0-c225-4411-85a9-118376b1a984',
 '7dbe5205-479a-40c9-ac4b-720d6956f6e9',
 '18acc4eb-ab1f-4c4b-8daa-30053cca939c',
 'bcd0ce4b-01da-404a-89be-54b54857450e',
 '9d6001f4-ad9c-40c1-943c-c241ffcc2bc7'
];

async function token(){
 const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
 if(!base||!req)throw new Error('OIDC_UNAVAILABLE');
 const r=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
 if(!r.ok)throw new Error('OIDC_'+r.status);
 return String((await r.json()).value||'');
}
const oidc=await token();
fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
const get=await fetch(EDGE,{headers:{authorization:'Bearer '+oidc}});
if(!get.ok)throw new Error('STATE_GET_'+get.status+' '+(await get.text()).slice(0,300));
fs.writeFileSync(TAR,Buffer.from(await get.arrayBuffer()));
if(spawnSync('tar',['-xzf',TAR,'-C',ROOT],{stdio:'inherit'}).status!==0)throw new Error('STATE_EXTRACT_FAILED');

const dbPath=ROOT+'/publisher-runtime/factory.sqlite';
const db=new DatabaseSync(dbPath);
const stamp=new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try{
  db.exec('DELETE FROM factory_generations; DELETE FROM publication_items; DELETE FROM factory_items;');
  try{db.exec("DELETE FROM factory_meta WHERE key LIKE 'flow:lifecycle:%' OR key LIKE 'recovery:golden:%' OR key LIKE 'automation:manualDailyTarget:%'")}catch{}
  const ins=db.prepare("INSERT INTO factory_items(id,season,episode,hook,story,prompt,title,description,status,providerRunId,flowResult,error,nextTry,createdAt,updatedAt) VALUES(?,?,?,?,?,'','','',?,?,?,?,0,?,?)");
  for(let i=0;i<episodes.length;i++){
    const ep=i+1,[hook,story]=episodes[i];
    const existing=i<6;
    const flowResult=existing?JSON.stringify({
      existing_flow_render:true,
      recovery_required:true,
      generation_submit_forbidden:true,
      flow_edit_id:flowEditIds[i],
      flow_edit_url:'https://flow.google.com/project/705d7ac2-30fe-4481-aa4c-076c31a64214/edit/'+flowEditIds[i]
    }):null;
    ins.run('frutti-t3-e'+ep,3,ep,hook,story,'draft',null,flowResult,existing?'EXISTING_FLOW_RENDER_RECOVERY_REQUIRED':null,stamp,stamp);
  }
  const put=db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  put.run('automation:activeSeason','3');
  put.run('automation:planner','fruttidrama-season3-recovered-v1');
  put.run('automation:factoryEnabled','false');
  put.run('flow:dailyCreditBatchOpen','false');
  put.run('flow:dailyCreditRefreshWaiting','true');
  put.run('recovery:fruttiSeason3','T3E1-T3E6 existing Flow renders locked for recovery; T3E7+ draft.');
  db.exec('COMMIT');
}catch(e){db.exec('ROLLBACK');throw e}
const rows=db.prepare("SELECT season,episode,hook,status,error,flowResult FROM factory_items ORDER BY episode").all();
db.close();
console.log('FRUTTI_STATE_REPAIRED',JSON.stringify(rows));

fs.rmSync(OUT,{force:true});
if(spawnSync('tar',['-czf',OUT,'-C',ROOT,'publisher-runtime','publisher-config.json'],{stdio:'inherit'}).status!==0)throw new Error('STATE_PACK_FAILED');
const putRes=await fetch(EDGE,{method:'PUT',headers:{authorization:'Bearer '+oidc,'content-type':'application/octet-stream'},body:fs.readFileSync(OUT)});
if(!putRes.ok)throw new Error('STATE_PUT_'+putRes.status+' '+(await putRes.text()).slice(0,300));
console.log('FRUTTI_STATE_UPLOAD_OK',await putRes.text());
