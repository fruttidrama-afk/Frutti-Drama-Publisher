
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const PERSISTED=path.join(DATA_DIR,'publisher-config.json');

function clean(v,n=80000){return String(v??'').trim().slice(0,n)}
function envConfig(){try{return JSON.parse(String(process.env.PUBLISHER_CONFIG_JSON||'{}'))}catch{return{}}}

export function loadConfig(){
  let c=envConfig();
  if(fs.existsSync(PERSISTED)){try{const p=JSON.parse(fs.readFileSync(PERSISTED,'utf8'));c={...c,...p}}catch{}}
  const identity=c.identity||{},content=c.content||{},generation=c.generation||{},review=c.review||{},schedule=c.schedule||{};
  const out={
    runtime_version:'publisher-runtime-v1',
    identity:{
      publisher_name:clean(identity.publisher_name||'Publisher',100),
      show_name:clean(identity.show_name||identity.publisher_name||'Show',100),
      description:clean(identity.description,2000),
      language:clean(identity.language||'es-419',40),
      timezone:clean(identity.timezone||schedule.timezone||'UTC',100),
      target_audience:clean(identity.target_audience||'general',120),
      content_category:clean(identity.content_category||'entertainment',120)
    },
    content:{
      videos_per_day:Math.max(1,Math.min(20,Number(content.videos_per_day||1))),
      serialized:content.serialized!==false,
      dialogue:content.dialogue!==false,
      voice_language:clean(content.voice_language||identity.language||'es-419',40),
      visual_style:clean(content.visual_style||'cinematic',12000),
      creative_bible:clean(content.creative_bible,80000),
      canon:clean(content.canon,80000),
      episode_structure:clean(content.episode_structure||'hook → development → payoff',4000),
      continuity_gate:clean(content.continuity_gate||(content.serialized!==false?'review_ready':'none'),40),
      initial_episodes:Array.isArray(content.initial_episodes)?content.initial_episodes.slice(0,500):[],
      autonomous_seed_ideas:Array.isArray(content.autonomous_seed_ideas)?content.autonomous_seed_ideas.slice(0,200):[]
    },
    characters:Array.isArray(c.characters)?c.characters.slice(0,100).map(x=>({
      name:clean(x?.name,100),
      flow_saved_name:clean(x?.flow_saved_name||x?.name,100),
      mention:clean(x?.mention||('@'+String(x?.flow_saved_name||x?.name||'')),120),
      aliases:Array.isArray(x?.aliases)?x.aliases.map(a=>clean(a,100)):[],
      role_rules:Array.isArray(x?.role_rules)?x.role_rules.map(String):['ON_SCREEN'],
      visual_rules:clean(x?.visual_rules,5000),
      voice_rules:clean(x?.voice_rules,5000),
      canon_metadata:clean(x?.canon_metadata,5000)
    })).filter(x=>x.name):[],
    generation:{
      provider:'google-flow',
      project_id:generation.project_id?clean(generation.project_id,200):null,
      project_url:generation.project_url?clean(generation.project_url,600):null,
      project_name:generation.project_name?clean(generation.project_name,120):null,
      model_intent:clean(generation.model_intent||'Omni video',120),
      resolution_intent:clean(generation.resolution_intent||'720p',60),
      download_quality:clean(generation.download_quality||'1080p Upscaled',80),
      duration_seconds:Math.max(1,Math.min(60,Number(generation.duration_seconds||10))),
      aspect_ratio:clean(generation.aspect_ratio||'9:16',20),
      output_count:Math.max(1,Math.min(4,Number(generation.output_count||1))),
      credits_per_generation:generation.credits_per_generation==null?null:Number(generation.credits_per_generation),
      daily_credit_budget:generation.daily_credit_budget==null?null:Number(generation.daily_credit_budget)
    },
    automation:{provider:'free-browser-provider',persistent_profile:true,tinyfish_required:false,semantic_field_safety:true,external_reality_reconciliation:true,...(c.automation||{})},
    review:{mode:clean(review.mode||'review',40),archive_provider:clean(review.archive_provider||'youtube-private-staging',80),hot_originals:Number(review.hot_originals??2),archive_below_free_percent:Number(review.archive_below_free_percent??45)},
    schedule:{timezone:clean(schedule.timezone||identity.timezone||'UTC',100),indefinite:true,generation_strategy:clean(schedule.generation_strategy||(content.serialized!==false?'sequential':'parallel'),40),posting_times:Array.isArray(schedule.posting_times)?schedule.posting_times.map(String):['19:00'],upload_lead_minutes:Number(schedule.upload_lead_minutes??390)},
    publication:c.publication||{providers:[{type:'youtube'}]},
    security:c.security||{passkeys:true,recovery_pin:true,session_management:true}
  };
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
  try{fs.writeFileSync(PERSISTED,JSON.stringify(out,null,2),{mode:0o600})}catch{}
  return out;
}
export const CONFIG=loadConfig();
export const SHOW=CONFIG.identity.show_name;
export const PROJECT_ID=String(CONFIG.generation.project_id||'');
export const PROJECT_URL=String(CONFIG.generation.project_url||(PROJECT_ID?('https://flow.google.com/project/'+PROJECT_ID):'https://flow.google.com/'));
export const PROJECT_NAME=String(CONFIG.generation.project_name||SHOW);
export const DURATION_SECONDS=CONFIG.generation.duration_seconds;
export const DURATION_LABEL=String(DURATION_SECONDS)+'s';
export const ASPECT_RATIO=CONFIG.generation.aspect_ratio;
export const OUTPUT_COUNT=CONFIG.generation.output_count;
export const OUTPUT_LABEL='x'+String(OUTPUT_COUNT);
export const MODEL_INTENT=CONFIG.generation.model_intent;
export const RESOLUTION_INTENT=CONFIG.generation.resolution_intent;
export const DAILY_LIMIT=CONFIG.content.videos_per_day;
export const CREDIT_PER_GENERATION=CONFIG.generation.credits_per_generation==null?15:Number(CONFIG.generation.credits_per_generation);
export const DAILY_CREDIT_BUDGET=CONFIG.generation.daily_credit_budget==null?DAILY_LIMIT*CREDIT_PER_GENERATION:Number(CONFIG.generation.daily_credit_budget);
export const TIMEZONE=CONFIG.schedule.timezone;

export function registry(){
  return {
    verified:Boolean(PROJECT_ID&&PROJECT_URL&&PROJECT_NAME),
    authRequired:false,
    projectName:PROJECT_NAME,
    projectUrl:PROJECT_URL,
    projectId:PROJECT_ID,
    modelName:MODEL_INTENT,
    generationOriginalResolution:RESOLUTION_INTENT,
    downloadResolution:CONFIG.generation.download_quality,
    resolution:RESOLUTION_INTENT,
    duration:DURATION_LABEL,
    aspectRatio:ASPECT_RATIO,
    outputCount:OUTPUT_COUNT,
    mentionSyntax:'@ + exact character name',
    referenceSelection:'Prompt box → Add ingredients to the prompt box → Characters → select the exact saved character → Add to prompt',
    characters:CONFIG.characters.map(c=>({name:c.flow_saved_name||c.name,mention:c.mention,aliases:c.aliases,reference:'Saved Flow Character asset'}))
  };
}
function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
export function resolveVisualCharacters(row){
  if(!CONFIG.characters.length)return[];
  const text=norm(String(row?.hook||'')+' '+String(row?.story||'')),words=new Set(text.split(' ').filter(Boolean)),found=[];
  for(const c of CONFIG.characters){
    const names=[c.name,c.flow_saved_name,...c.aliases].map(norm).filter(Boolean);
    const tokens=names.flatMap(x=>x.split(' ')).filter(x=>x.length>=3);
    if(names.some(n=>text.includes(n))||tokens.some(t=>words.has(t)))found.push(c.flow_saved_name||c.name);
  }
  return [...new Set(found)].slice(0,3);
}
export function previousContinuity(db,row){
  if(!CONFIG.content.serialized)return'Independent episode. Do not invent continuity unless explicitly present in the supplied story.';
  const prev=db.prepare('SELECT hook,story,status FROM factory_items WHERE episode<? ORDER BY episode DESC LIMIT 1').get(Number(row.episode));
  if(prev)return 'Previous canonical beat: '+prev.hook+' — '+prev.story;
  return CONFIG.content.canon?'Established canon: '+CONFIG.content.canon.slice(0,12000):'Begin from the configured show bible without inventing prior events.';
}
export function buildPrompt(db,row,visual=[]){
  const mentions=visual.map(n=>{
    const c=CONFIG.characters.find(x=>(x.flow_saved_name||x.name)===n);
    return c?.mention||('@'+n);
  });
  const referenceBlock=mentions.length
    ? 'Use ONLY these attached saved Flow visual assets as ON_SCREEN subjects: '+mentions.join(', ')+'. Saved Flow assets are the visual identity authority. Do not duplicate, substitute or redesign them.'
    : 'This episode uses no saved character ingredients unless explicitly attached by configuration. Do not invent recurring characters.';
  const dialogueRule=CONFIG.content.dialogue
    ? 'Dialogue is allowed. Voice language: '+CONFIG.content.voice_language+'. Explicitly assign speakers; one voice at a time unless the Creative Bible says otherwise.'
    : 'No spoken dialogue. Tell the beat visually with ambience and synchronized sound.';
  const lines=[
    SHOW.toUpperCase()+' — EPISODE '+row.episode,
    '',
    'GENERATION',
    'Generate exactly ONE complete '+DURATION_SECONDS+'-second video.',
    'Aspect ratio: '+ASPECT_RATIO+'.',
    'Exactly '+OUTPUT_COUNT+' output(s).',
    'Google Flow video mode. Requested model intent: '+MODEL_INTENT+'.',
    'Requested original resolution: '+RESOLUTION_INTENT+'.',
    '',
    'CREATIVE BIBLE',
    CONFIG.content.creative_bible||'Follow the supplied episode story exactly and keep a coherent cinematic visual language.',
    '',
    'CANON / CONTINUITY',
    previousContinuity(db,row),
    CONFIG.content.canon?('Permanent/current canon: '+CONFIG.content.canon):'',
    '',
    'ASSET / CHARACTER LOCK',
    referenceBlock,
    '',
    'STORY',
    'HOOK: '+row.hook,
    'EPISODE INTENT: '+row.story,
    'Render this exact narrative intent. Treat the operator/story input as semantic intent, not final dialogue or copy. Do not invent contradictory canon.',
    '',
    'BEATS / TIMING',
    'Structure: '+(CONFIG.content.episode_structure||'hook → development → payoff')+'.',
    'Fit all beats cleanly inside exactly '+DURATION_SECONDS+' seconds. Every beat must advance story, clarity or payoff.',
    '',
    'CAMERA',
    'Use purposeful cinematic framing and coherent geography. No arbitrary camera teleportation. Preserve subject identity and spatial continuity across cuts.',
    '',
    'LIGHTING / VISUAL STYLE',
    CONFIG.content.visual_style||'Cinematic, coherent and polished.',
    '',
    'EMOTION / PERFORMANCE',
    'Make emotion legible immediately and consistent with the episode intent. Avoid accidental comedy unless configured.',
    '',
    'DIALOGUE / VOICE / AUDIO',
    dialogueRule,
    'Use continuous appropriate ambience. Keep speech intelligible. Do not overlap voices accidentally.',
    '',
    'END STATE',
    'End on a clear payoff, consequence, reveal or configured cliffhanger that can seed the next content item when serialized.',
    '',
    'ANTI-GLITCH / NEGATIVE',
    'No duplicate subjects. No identity drift. No unintended extra characters. No malformed anatomy. No arbitrary morphs. No accidental subtitles, captions, logos, watermarks or UI. No wrong-speaker lip movement. No unintended readable text. Preserve attached saved assets exactly.'
  ];
  let out=lines.filter((x,i)=>x!==''||lines[i-1]!=='').join('\n');
  for(const n of visual){
    const c=CONFIG.characters.find(x=>(x.flow_saved_name||x.name)===n),m=c?.mention||('@'+n),bare=c?.flow_saved_name||c?.name||n;
    const token='__PUBLISHER_MENTION_'+Math.random().toString(36).slice(2)+'__';
    out=out.split(m).join(token).split(bare).join(m).split(token).join(m);
  }
  return out.trim();
}
export function ideaForEpisode(episode){
  const i=Number(episode)-1,initial=CONFIG.content.initial_episodes[i];
  if(initial){
    if(Array.isArray(initial))return{hook:String(initial[0]||('EPISODE '+episode)),story:String(initial[1]||'')};
    return{hook:String(initial.hook||initial.title||('EPISODE '+episode)),story:String(initial.story||initial.intent||initial.description||'')};
  }
  const seeds=CONFIG.content.autonomous_seed_ideas;
  if(seeds.length){
    const v=seeds[i%seeds.length],cycle=Math.floor(i/seeds.length)+1;
    if(typeof v==='string')return{hook:'NEW TURN',story:v+' Continuation cycle '+cycle+'. Preserve canon and create a new consequence rather than repeating the previous episode.'};
    return{hook:String(v.hook||'NEW TURN'),story:String(v.story||v.intent||'')+' Continuation cycle '+cycle+'.'};
  }
  return{hook:'NEXT CHAPTER',story:'Continue the configured Creative Bible and canon from the previous accepted beat. Introduce one new consequential development, resolve one immediate tension, and end with a fresh hook. Do not repeat the previous episode.'};
}
export function ensureBacklog(db,minReady=Math.max(9,DAILY_LIMIT*3)){
  const max=Number(db.prepare('SELECT COALESCE(MAX(episode),0) ep FROM factory_items').get()?.ep||0);
  const pending=Number(db.prepare("SELECT COUNT(*) n FROM factory_items WHERE status IN ('draft','regen_wait','generating')").get()?.n||0);
  const need=Math.max(0,minReady-pending),t=new Date().toISOString();
  for(let k=1;k<=need;k++){
    const ep=max+k,idea=ideaForEpisode(ep);
    db.prepare("INSERT OR IGNORE INTO factory_items(id,season,episode,hook,story,status,createdAt,updatedAt) VALUES(lower(hex(randomblob(16))),1,?,?,?,?,?,?)")
      .run(ep,idea.hook,idea.story,'draft',t,t);
  }
}
export function seedInitial(db){
  const count=Number(db.prepare('SELECT COUNT(*) n FROM factory_items').get()?.n||0);
  if(count)return;
  const t=new Date().toISOString(),initial=CONFIG.content.initial_episodes;
  if(initial.length){
    for(let i=0;i<initial.length;i++){
      const idea=ideaForEpisode(i+1);
      db.prepare("INSERT INTO factory_items(id,season,episode,hook,story,status,createdAt,updatedAt) VALUES(lower(hex(randomblob(16))),1,?,?,?,?,?,?)")
        .run(i+1,idea.hook,idea.story,'draft',t,t);
    }
  }
  ensureBacklog(db);
}
