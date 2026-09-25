
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildPublicationCopy } from './publication-copy.js';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const PERSISTED=path.join(DATA_DIR,'publisher-config.json');

function clean(v,n=80000){return String(v??'').trim().slice(0,n)}
function envConfig(){try{return JSON.parse(String(process.env.PUBLISHER_CONFIG_JSON||'{}'))}catch{return{}}}

export function loadConfig(){
  const env=envConfig();let persisted={};
  if(fs.existsSync(PERSISTED)){try{persisted=JSON.parse(fs.readFileSync(PERSISTED,'utf8'))||{}}catch{}}
  // Factory/environment config is authoritative for creative, branding and policy fields.
  // Persisted runtime state is authoritative only for connection data learned during setup
  // (especially the Google Flow project identifiers). This lets redeploys update a Publisher
  // automatically without erasing its authenticated Flow connection.
  const envGen=env.generation||{},persistedGen=persisted.generation||{};
  const generation={...persistedGen,...envGen,
    project_id:envGen.project_id||persistedGen.project_id||null,
    project_url:envGen.project_url||persistedGen.project_url||null,
    project_name:envGen.project_name||persistedGen.project_name||null
  };
  const c={...persisted,...env,
    identity:{...(persisted.identity||{}),...(env.identity||{})},
    branding:{...(persisted.branding||{}),...(env.branding||{})},
    content:{...(persisted.content||{}),...(env.content||{})},
    characters:Array.isArray(env.characters)?env.characters:(persisted.characters||[]),
    generation,
    automation:{...(persisted.automation||{}),...(env.automation||{})},
    review:{...(persisted.review||{}),...(env.review||{})},
    schedule:{
      ...(env.schedule||{}),
      ...(persisted.schedule||{}),
      timezone:persisted.schedule?.timezone||env.schedule?.timezone||env.identity?.timezone||persisted.identity?.timezone||'UTC',
      posting_times:Array.isArray(persisted.schedule?.posting_times)&&persisted.schedule.posting_times.length
        ?persisted.schedule.posting_times
        :(env.schedule?.posting_times||['19:00'])
    },
    publication:{
      ...(env.publication||{}),
      ...(persisted.publication||{}),
      allowed_providers:Array.isArray(env.publication?.allowed_providers)?env.publication.allowed_providers:(persisted.publication?.allowed_providers||['youtube','facebook']),
      selected_provider:(persisted.publication?.selected_provider!=null?persisted.publication.selected_provider:(env.publication?.selected_provider??null)),
      providers:Array.isArray(persisted.publication?.providers)&&persisted.publication.providers.length
        ?persisted.publication.providers
        :(env.publication?.providers||[])
    },
    security:{...(persisted.security||{}),...(env.security||{})}
  };
  const identity=c.identity||{},content=c.content||{},review=c.review||{},schedule=c.schedule||{};
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
    branding:{
      reference_mode:clean(c.branding?.reference_mode||'',40)||null,
      reference_image_url:clean(c.branding?.reference_image_url||'',2000)||null,
      render_reference_image:c.branding?.reference_mode==='web_design'?false:(c.branding?.render_reference_image!==false),
      reference_usage:clean(c.branding?.reference_usage||(c.branding?.reference_mode==='web_design'?'design-spec-only':'visual-brand-source'),80),
      logo_url:clean(c.branding?.logo_url||'',2000)||null,
      logo_source:clean(c.branding?.logo_source||'',40)||null,
      icon_180_url:clean(c.branding?.icon_180_url||'',2000)||null,
      icon_192_url:clean(c.branding?.icon_192_url||'',2000)||null,
      icon_512_url:clean(c.branding?.icon_512_url||'',2000)||null,
      maskable_icon_url:clean(c.branding?.maskable_icon_url||c.branding?.icon_512_url||'',2000)||null,
      safe_area_ratio:Math.max(.5,Math.min(.95,Number(c.branding?.safe_area_ratio||.8))),
      tagline:clean(c.branding?.tagline||identity.description||'',500),
      theme:{
        primary:clean(c.branding?.theme?.primary||'#0d3152',40),
        secondary:clean(c.branding?.theme?.secondary||'#b59a64',40),
        accent:clean(c.branding?.theme?.accent||c.branding?.theme?.secondary||'#b59a64',40),
        background:clean(c.branding?.theme?.background||'#f7f6f2',40),
        surface:clean(c.branding?.theme?.surface||'#ffffff',40),
        text:clean(c.branding?.theme?.text||'#1d1d1b',40)
      }
    },
    content:{
      videos_per_day:Math.max(1,Math.min(20,Number(process.env.PUBLISHER_VIDEOS_PER_DAY||content.videos_per_day||1))),
      serialized:content.serialized!==false,
      dialogue:content.dialogue!==false,
      voice_language:clean(content.voice_language||identity.language||'es-419',40),
      visual_style:clean(content.visual_style||'cinematic',12000),
      creative_bible:clean(content.creative_bible,80000),
      canon:clean(content.canon,80000),
      episode_structure:clean(content.episode_structure||'hook → development → payoff',4000),
      continuity_gate:clean(content.continuity_gate||(content.serialized!==false?'approved':'none'),40),
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
    review:{mode:clean(review.mode||'review',40),archive_provider:clean(review.archive_provider||'private-cloud-storage',80),hot_originals:Number(review.hot_originals??2),archive_below_free_percent:Number(review.archive_below_free_percent??45)},
    schedule:{
      timezone:clean(schedule.timezone||identity.timezone||'UTC',100),
      indefinite:true,
      generation_strategy:'sequential',
      posting_times:Array.isArray(schedule.posting_times)&&schedule.posting_times.length
        ?[...new Set(schedule.posting_times.map(v=>clean(v,5)).filter(v=>/^\d{2}:\d{2}$/.test(v)))].slice(0,20)
        :['19:00'],
      upload_lead_minutes:Math.max(0,Math.min(1440,Number(schedule.upload_lead_minutes??390)))
    },
    publication:c.publication||{allowed_providers:['youtube','facebook'],selected_provider:null,providers:[]},
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
    ...(String(row.retryStrategy||'')==='revise_prompt'&&String(row.reviewFeedback||'').trim()?[
      '',
      'HUMAN REDO CORRECTION',
      'The reviewer rejected the previous render for this specific reason: '+String(row.reviewFeedback||'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,1200)+'.',
      'Correct exactly this failure while preserving the same episode story, canon, characters and all unrelated constraints. Never mention the review inside the video.'
    ]:[]),
    '',
    'BEATS / TIMING',
    'Structure: '+(CONFIG.content.episode_structure||'hook → development → payoff')+'.',
    'Fit all beats cleanly inside exactly '+DURATION_SECONDS+' seconds. Every beat must advance story, clarity or payoff.',
    '',
    'CAMERA',
    'Use purposeful cinematic framing and coherent geography. No arbitrary camera teleportation. Preserve subject identity and spatial continuity across cuts.',
    '',
    'LIGHTING / VISUAL STYLE',
    effectiveVideoVisualStyle(),
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
const EARTH_IN_10_AUTONOMOUS_EPISODES=[
  {hook:'ICELAND BLACK SAND',place:'Reynisfjara Iceland',family:'black-volcanic-beach-seastacks',story:'A cinematic sunrise on Iceland’s black volcanic coast. Cold Atlantic waves roll across glossy black sand beneath towering basalt sea stacks while pale golden light breaks through low clouds and sea mist.'},
  {hook:'ZHANGJIAJIE MIST',place:'Zhangjiajie China',family:'sandstone-pillars-mist',story:'A cinematic flight-like push through China’s Zhangjiajie sandstone pillars at dawn. Layers of tall quartz-sandstone towers emerge from drifting white mist while soft morning light creates immense atmospheric depth.'},
  {hook:'UYUNI MIRROR',place:'Salar de Uyuni Bolivia',family:'mirror-salt-flat',story:'A cinematic sunrise over Bolivia’s Salar de Uyuni after rain. A perfectly thin sheet of water turns the salt flat into an endless mirror, reflecting pastel clouds and distant mountains with a seamless horizon.'},
  {hook:'FAROE CLIFFS',place:'Faroe Islands',family:'green-sea-cliff-waterfall',story:'A dramatic cinematic view of the Faroe Islands. Deep green sea cliffs fall into the North Atlantic as a narrow waterfall blows sideways in ocean wind beneath moving storm-light and mist.'},
  {hook:'DOLOMITES DAWN',place:'Dolomites Italy',family:'pale-alpine-spires',story:'A cinematic dawn in the Italian Dolomites. Jagged pale-rock peaks catch warm alpenglow above a quiet alpine valley while thin clouds slide naturally across the mountain faces.'},
  {hook:'LENÇÓIS LAGOONS',place:'Lencois Maranhenses Brazil',family:'white-dunes-blue-lagoons',story:'A cinematic aerial-style push across Brazil’s Lençóis Maranhenses. Brilliant blue seasonal lagoons sit between sweeping white dunes under clean tropical light, with wind tracing subtle patterns across the sand.'},
  {hook:'MILFORD SOUND',place:'Milford Sound New Zealand',family:'fjord-cliffs-many-waterfalls',story:'A cinematic rainy morning in New Zealand’s Milford Sound. Sheer dark cliffs rise from calm water while dozens of temporary waterfalls stream through low clouds and drifting mist.'},
  {hook:'ATACAMA STARS',place:'Atacama Desert Chile',family:'high-desert-starry-blue-hour',story:'A cinematic blue-hour transition in Chile’s Atacama Desert. Rust-colored mountains and salt flats sit beneath an exceptionally clear deepening sky as the first bright stars become visible above the silent landscape.'},
  {hook:'PLITVICE WATER',place:'Plitvice Lakes Croatia',family:'forest-limestone-cascade-pools',story:'A cinematic glide through Croatia’s Plitvice Lakes. Crystal turquoise water spills over moss-covered limestone terraces into layered pools surrounded by dense green forest and soft natural haze.'},
  {hook:'LOFOTEN LIGHT',place:'Lofoten Islands Norway',family:'arctic-peaks-calm-sea',story:'A cinematic Arctic sunrise in Norway’s Lofoten Islands. Sharp snow-covered peaks rise directly from calm blue water while warm low-angle light reaches a tiny curve of untouched shoreline.'},
  {hook:'SOCOTRA DRAGONS',place:'Socotra Yemen',family:'dragon-blood-tree-plateau',story:'A cinematic golden-hour landscape on Socotra Island, Yemen. Strange dragon’s-blood trees stand across a rocky plateau above a distant turquoise sea, rendered with documentary-level realism.'},
  {hook:'TORRES DEL PAINE',place:'Torres del Paine Chile',family:'granite-towers-turquoise-lake',story:'A cinematic dawn in Torres del Paine, Chile. Granite towers rise beyond a windswept turquoise lake while fast Patagonian clouds reveal brief shafts of warm sunrise light.'},
  {hook:'NAICA CRYSTALS',place:'Naica Crystal Cave Mexico',family:'giant-crystal-cave',story:'A cinematic glide through Mexico’s Naica Crystal Cave. Colossal translucent selenite crystals cross the cavern like frozen beams while warm mineral light reveals immense scale and crystalline depth.'},
  {hook:'BAIKAL BLUE ICE',place:'Lake Baikal Russia',family:'clear-blue-lake-ice-cracks',story:'A cinematic winter crossing of Lake Baikal. Transparent blue ice stretches to the horizon with deep white fracture lines beneath the surface and low amber sunlight skimming across the frozen lake.'},
  {hook:'RAJA AMPAT KARSTS',place:'Raja Ampat Indonesia',family:'tropical-karst-islets',story:'A cinematic aerial glide above Raja Ampat. Hundreds of steep jungle-covered limestone islets rise from luminous turquoise water with coral shallows visible beneath a humid tropical sky.'},
  {hook:'RORAIMA CLOUDS',place:'Mount Roraima Venezuela',family:'tabletop-mountain-cloudfalls',story:'A cinematic reveal of Mount Roraima. The enormous flat-topped tepui rises above a sea of clouds while thin waterfalls spill from its vertical walls into mist far below.'},
  {hook:'REDWOOD FOG',place:'Redwood National Park California',family:'giant-redwood-fog-forest',story:'A slow cinematic push through a coastal redwood forest in California. Monumental trunks disappear into cool fog while soft shafts of morning light reach a fern-covered forest floor.'},
  {hook:'KAWAH IJEN BLUE FIRE',place:'Kawah Ijen Indonesia',family:'volcano-blue-fire-night',story:'A cinematic night view inside Indonesia’s Kawah Ijen crater. Electric-blue sulfur flames flicker along dark volcanic rock while pale acidic crater water glows faintly beneath drifting vapor.'},
  {hook:'GREAT BLUE HOLE',place:'Great Blue Hole Belize',family:'circular-ocean-sinkhole-aerial',story:'A perfectly vertical cinematic aerial over Belize’s Great Blue Hole. A vast dark cobalt circle drops through bright turquoise reef water, revealing its geometric scale against the Caribbean sea.'},
  {hook:'PAMUKKALE WHITE',place:'Pamukkale Turkey',family:'white-travertine-terraces',story:'A cinematic side glide across Pamukkale’s white travertine terraces in Turkey. Shallow mineral pools step down brilliant chalk-white formations under clean late-afternoon light.'},
  {hook:'ANTELOPE CANYON LIGHT',place:'Antelope Canyon Arizona',family:'slot-canyon-light-beams',story:'A cinematic passage through Antelope Canyon. Smooth red-orange sandstone walls twist around a narrow slot while a single shaft of sunlight cuts through suspended dust from far above.'},
  {hook:'SVALBARD ICE WALL',place:'Svalbard Norway',family:'glacier-ice-wall-arctic-sea',story:'A cinematic Arctic approach to a Svalbard glacier front. A towering blue-white ice wall meets dark polar water as small fragments calve naturally beneath a cold overcast sky.'},
  {hook:'BANAUE TERRACES',place:'Banaue Philippines',family:'green-rice-terraces-mountains',story:'A cinematic morning sweep across the Banaue rice terraces. Layered emerald fields contour steep mountainsides while thin fog lifts from the valley and water glints along the terrace edges.'},
  {hook:'DANXIA RAINBOW',place:'Zhangye Danxia China',family:'rainbow-banded-mountains',story:'A cinematic sunrise over Zhangye Danxia. Vast mountains display natural bands of red, gold, orange and gray rock as low-angle light reveals folded geological layers across the landscape.'},
  {hook:'IGUAZU THUNDER',place:'Iguazu Falls Argentina Brazil',family:'mega-waterfall-rainforest',story:'A cinematic wide reveal of Iguazú Falls. Hundreds of powerful cascades break through dense subtropical forest while rising mist catches sunlight above the immense river gorge.'},
  {hook:'MARBLE CAVES',place:'Marble Caves Chile',family:'blue-marble-water-cavern',story:'A cinematic boat-level glide inside Chile’s Marble Caves. Swirling blue-and-white stone arches reflect in intensely turquoise water while soft daylight enters through openings in the rock.'},
  {hook:'CHOCOLATE HILLS',place:'Chocolate Hills Bohol Philippines',family:'rounded-green-karst-hills',story:'A cinematic aerial drift above Bohol’s Chocolate Hills during the green season. Hundreds of nearly symmetrical rounded hills repeat across the horizon beneath soft tropical cloud shadows.'},
  {hook:'DALLOL COLORS',place:'Dallol Ethiopia',family:'neon-geothermal-mineral-field',story:'A cinematic ground-level reveal of Dallol in Ethiopia. Neon yellow, green and orange mineral terraces surround steaming acidic pools in an otherworldly but geologically realistic geothermal field.'},
  {hook:'CAPPADOCIA DAWN',place:'Cappadocia Turkey',family:'fairy-chimneys-balloons',story:'A cinematic dawn over Cappadocia. Sculpted fairy-chimney rock formations fill a broad valley while a few distant hot-air balloons rise slowly through warm morning haze.'},
  {hook:'PERITO MORENO',place:'Perito Moreno Glacier Argentina',family:'glacier-face-turquoise-lake',story:'A cinematic lateral view of Perito Moreno Glacier in Patagonia. A massive fractured blue ice face rises above milky turquoise water while distant mountains remain sharply visible in cold clear air.'},
  {hook:'TSINGY LIMESTONE',place:'Tsingy de Bemaraha Madagascar',family:'razor-limestone-forest',story:'A cinematic aerial push over Madagascar’s Tsingy de Bemaraha. Endless razor-sharp gray limestone pinnacles form a stone forest cut by narrow green fissures and isolated vegetation.'},
  {hook:'WAITOMO GLOW',place:'Waitomo Glowworm Caves New Zealand',family:'glowworm-cave-river',story:'A cinematic glide through Waitomo’s underground river. Thousands of blue-green glowworms illuminate the cave ceiling like a living night sky above black water and sculpted limestone.'},
  {hook:'KELIMUTU CRATERS',place:'Kelimutu Indonesia',family:'multi-color-crater-lakes',story:'A cinematic sunrise over Mount Kelimutu. Three volcanic crater lakes with naturally different colors sit inside dark ridges as mountain mist withdraws from the rims.'},
  {hook:'CAÑO CRISTALES',place:'Cano Cristales Colombia',family:'multicolor-river-plants',story:'A cinematic low flight along Colombia’s Caño Cristales. Clear water moves over red, yellow and green aquatic plants between smooth rock shelves, creating a naturally multicolored river.'},
  {hook:'SALTO ANGEL',place:'Angel Falls Venezuela',family:'single-tall-waterfall-tepui',story:'A cinematic telephoto reveal of Angel Falls. A single impossibly tall ribbon of water drops from a sheer tepui into tropical cloud and spray before reaching the forest far below.'},
  {hook:'NAMAKWA BLOOM',place:'Namaqualand South Africa',family:'desert-wildflower-carpet',story:'A cinematic spring landscape in Namaqualand. Vast dry plains are suddenly carpeted in dense orange, yellow and purple wildflowers beneath a huge clean South African sky.'},
  {hook:'OKAVANGO CHANNELS',place:'Okavango Delta Botswana',family:'wetland-channels-aerial',story:'A cinematic aerial over the Okavango Delta. Bright green wetlands are divided by winding blue channels and small palm islands, forming an intricate natural pattern across the floodplain.'},
  {hook:'BROMO SEA OF CLOUDS',place:'Mount Bromo Indonesia',family:'volcanic-caldera-cloud-sea',story:'A cinematic dawn above Mount Bromo. A smoking volcanic cone rises from a vast caldera filled with low cloud while sharper peaks catch warm sunrise light in the distance.'},
  {hook:'LAKE NATRON RED',place:'Lake Natron Tanzania',family:'red-alkaline-lake-patterns',story:'A cinematic aerial over Tanzania’s Lake Natron. Crimson and coral mineral patterns spread across shallow alkaline water, divided by pale salt lines and dark volcanic shoreline.'},
  {hook:'MOUNT COOK GLACIAL',place:'Aoraki Mount Cook New Zealand',family:'glacial-valley-braided-river',story:'A cinematic valley push toward Aoraki Mount Cook. A pale braided glacial river winds across a broad gravel valley beneath snow-covered peaks and crisp alpine cloud.'},
  {hook:'HUANGSHAN PINES',place:'Huangshan China',family:'granite-peaks-pine-cloudsea',story:'A cinematic sunrise in Huangshan. Sculpted granite peaks and wind-shaped pine trees rise above a glowing sea of clouds while distant ridges fade into atmospheric layers.'},
  {hook:'JÖKULSÁRLÓN ICE',place:'Jokulsarlon Iceland',family:'iceberg-lagoon-black-shore',story:'A cinematic blue-hour view of Jökulsárlón. Sculpted icebergs drift through a dark glacial lagoon toward a black shoreline, glowing blue against subdued Arctic light.'},
  {hook:'GIANTS CAUSEWAY',place:'Giants Causeway Northern Ireland',family:'hexagonal-basalt-coast',story:'A cinematic low glide across Giant’s Causeway. Thousands of wet hexagonal basalt columns step toward a rough gray Atlantic beneath dramatic moving cloud.'},
  {hook:'MEKONG WATERFALL',place:'Khone Phapheng Laos',family:'wide-river-rapids-islands',story:'A cinematic aerial reveal of Khone Phapheng on the Mekong. Powerful braided rapids split around dark rock islands and green vegetation across an exceptionally wide river corridor.'},
  {hook:'DEADVLEI SKELETONS',place:'Deadvlei Namibia',family:'white-clay-black-trees-red-dunes',story:'A cinematic midday composition at Deadvlei. Black skeletal camel-thorn trees stand on a white clay pan beneath immense red dunes and a hard cobalt sky with stark natural contrast.'},
  {hook:'MENDENHALL ICE CAVE',place:'Mendenhall Glacier Alaska',family:'blue-ice-cave-river',story:'A cinematic passage beneath Alaska’s Mendenhall Glacier. Translucent blue ice arches over a shallow meltwater stream while trapped bubbles and layered ice textures glow from within.'},
  {hook:'WULINGYUAN BRIDGE',place:'Tianzi Mountain China',family:'stone-bridge-cloud-valley',story:'A cinematic reveal of a natural stone bridge high above a cloud-filled valley near Tianzi Mountain, with steep forested rock walls disappearing into white mist.'},
  {hook:'SAKURA FUJI',place:'Mount Fuji Japan',family:'volcano-cherry-blossom-lake',story:'A cinematic spring dawn facing Mount Fuji. Snow-capped volcanic symmetry rises beyond a calm lake while foreground cherry blossoms move gently in cool morning air.'}
];

function earthConfiguredSpecificInitialCount(){
  return (CONFIG.content.initial_episodes||[]).filter(v=>{
    const hook=Array.isArray(v)?String(v[0]||''):String(v?.hook||v?.title||'');
    const story=Array.isArray(v)?String(v[1]||''):String(v?.story||v?.intent||v?.description||'');
    return !(/^NEXT CHAPTER$/i.test(hook.trim())||/Continue the configured Creative Bible and canon from the previous accepted beat/i.test(story));
  }).length;
}
function earthNorm(v){
  return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function earthWords(v){
  const stop=new Set(['cinematic','cinema','video','episode','earth','show','bible','generate','exactly','seconds','second','with','from','into','while','under','above','below','across','through','their','this','that','realistic','hyperrealistic','natural','light','view','glide','reveal','morning','sunrise','dawn','late','early']);
  return new Set((earthNorm(v).match(/[a-z0-9]{4,}/g)||[]).filter(x=>!stop.has(x)));
}
function earthJaccard(a,b){
  const A=earthWords(a),B=earthWords(b);if(!A.size||!B.size)return 0;
  let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/(A.size+B.size-hit);
}
const EARTH_VISUAL_TAGS=[
  ['desert',/desert|dune|sand|arid|deadvlei|atacama|namib/i],
  ['saltflat',/salt flat|salt pan|salar|uyuni|alkaline/i],
  ['coast',/coast|shore|beach|atlantic|sea stack|ocean/i],
  ['cliff',/cliff|sheer wall|vertical wall|sea cliff/i],
  ['waterfall',/waterfall|falls|cascade|cascades/i],
  ['forest',/forest|redwood|jungle|rainforest|trees|pine/i],
  ['lake',/lake|lagoon|pool|water/i],
  ['mountain',/mountain|peak|peaks|alpine|granite tower|tepui/i],
  ['karst',/karst|limestone|pillar|pinnacle|fairy chimney/i],
  ['cave',/cave|cavern|underground|slot canyon/i],
  ['ice',/ice|glacier|frozen|iceberg|snow/i],
  ['volcano',/volcan|crater|caldera|sulfur/i],
  ['wetland',/wetland|delta|floodplain|channels/i],
  ['terrace',/terrace|terraces|rice fields/i],
  ['river',/river|rapids|braided/i],
  ['geothermal',/geothermal|acidic pools|mineral field|hot spring/i]
];
function earthVisualTags(v){const s=String(v||'');return new Set(EARTH_VISUAL_TAGS.filter(([,re])=>re.test(s)).map(([k])=>k))}
function earthCandidateForText(v){
  const n=earthNorm(v);
  let best=null,bestScore=0;
  for(const x of EARTH_IN_10_AUTONOMOUS_EPISODES){
    const h=earthNorm(x.hook),p=earthNorm(x.place);
    const score=(h&&n.includes(h)?4:0)+(p&&n.includes(p)?5:0)+earthJaccard(v,x.story)*3;
    if(score>bestScore){best=x;bestScore=score}
  }
  return bestScore>=2?best:null;
}
function earthIdeaConflict(db,row,candidate){
  const mine=[candidate.hook,candidate.place,candidate.story].join(' ');
  const myHook=earthNorm(candidate.hook),myPlace=earthNorm(candidate.place),myTags=earthVisualTags(mine);
  const rows=db.prepare("SELECT id,episode,status,hook,story,title,description,prompt FROM factory_items WHERE id<>? ORDER BY episode").all(row.id);
  for(const other of rows){
    const text=[other.hook,other.story,other.title,other.description,other.prompt].filter(Boolean).join(' ');
    if(!text.trim())continue;
    const n=earthNorm(text);
    if(myHook&&n.includes(myHook))return{other,reason:'same-hook'};
    if(myPlace&&n.includes(myPlace))return{other,reason:'same-place'};
    const known=earthCandidateForText(text);
    if(known&&known.family===candidate.family)return{other,reason:'same-visual-family'};
    const jac=earthJaccard(mine,text);
    if(jac>=0.36)return{other,reason:'semantic-overlap:'+jac.toFixed(2)};
    const tags=earthVisualTags(text);let overlap=0;for(const t of myTags)if(tags.has(t))overlap++;
    if(overlap>=2&&jac>=0.16)return{other,reason:'visual-overlap:'+overlap+':'+jac.toFixed(2)};
  }
  return null;
}
function earthIn10Idea(db,row){
  const base=Math.max(0,Number(row?.episode||0)-earthConfiguredSpecificInitialCount()-1);
  for(let step=0;step<EARTH_IN_10_AUTONOMOUS_EPISODES.length;step++){
    const x=EARTH_IN_10_AUTONOMOUS_EPISODES[(base+step)%EARTH_IN_10_AUTONOMOUS_EPISODES.length];
    if(!earthIdeaConflict(db,row,x))return x;
  }
  throw new Error('CONTENT_GATE: EARTH_UNIQUE_IDEA_BANK_EXHAUSTED — refusing to repeat a landscape.');
}
function earthCurrentIntentConflict(db,row){
  const text=[row?.hook,row?.story,row?.title,row?.description,row?.prompt].filter(Boolean).join(' ');
  const known=earthCandidateForText(text);
  if(known)return earthIdeaConflict(db,row,known);
  const candidate={hook:String(row?.hook||''),place:String(row?.hook||''),family:'legacy:'+earthNorm(row?.hook||''),story:String(row?.story||'')};
  return earthIdeaConflict(db,row,candidate);
}

function isEarthIn10(){return /earth\s*in\s*10/i.test(String(SHOW||CONFIG.identity?.show_name||''));}
function isGenericAutonomousIdea(hook,story){
  return /^NEXT CHAPTER$/i.test(String(hook||'').trim())||/Continue the configured Creative Bible and canon from the previous accepted beat/i.test(String(story||''));
}
function publisherWebStyleLeak(v){
  return /web reference|layout authority|publisher|website|webpage|page layout|logo consistently|app design|interface design|ui design/i.test(String(v||''));
}
function effectiveVideoVisualStyle(){
  const configured=String(CONFIG.content.visual_style||'').trim();
  if(!isEarthIn10())return configured||'Cinematic, coherent and polished.';
  const earth='Hyperrealistic premium travel-documentary landscape cinematography. The real geographic location named in EPISODE INTENT is the visual authority. Preserve recognizable geology, vegetation, climate, water, architecture and atmospheric conditions for that place. Natural physically coherent light, realistic depth, stable terrain and purposeful camera movement. No real-estate walkthrough, property showcase, interior-design reel, website aesthetic, app/UI styling, branding layout or generic luxury architecture.';
  if(!configured||/^cinematic$/i.test(configured)||publisherWebStyleLeak(configured))return earth;
  return earth+' Additional configured video style: '+configured;
}
export function enforceEpisodeIntent(db,row){
  let forcedIntents={};
  try{forcedIntents=JSON.parse(String(process.env.PUBLISHER_FORCE_NEW_INTENTS_JSON||'{}'))||{}}catch{}
  const forced=forcedIntents[String(row?.episode||'')]||forcedIntents[Number(row?.episode||0)];
  if(forced){
    const hook=String(forced.hook||'').trim(),story=String(forced.story||'').trim();
    if(hook&&story&&(String(row.hook||'')!==hook||String(row.story||'')!==story)){
      db.prepare("UPDATE factory_items SET hook=?,story=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
        .run(hook,story,new Date().toISOString(),row.id);
      row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row;
    }
  }
  const genericIntent=isGenericAutonomousIdea(row?.hook,row?.story);
  const prompt=String(row?.prompt||'');
  const staleGenericPrompt=/HOOK:\s*NEXT CHAPTER/i.test(prompt)||/EPISODE INTENT:\s*Continue the configured Creative Bible and canon from the previous accepted beat/i.test(prompt);
  let repaired=false,reason=null;
  if(genericIntent){
    const idea=isEarthIn10()?earthIn10Idea(db,row):ideaForEpisode(Number(row.episode));
    if(!idea||isGenericAutonomousIdea(idea.hook,idea.story)){
      throw new Error('CONTENT_GATE: concrete episode intent required before Flow generation; internal NEXT CHAPTER planner placeholders are forbidden.');
    }
    db.prepare("UPDATE factory_items SET hook=?,story=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
      .run(idea.hook,idea.story,new Date().toISOString(),row.id);
    repaired=true;reason=isEarthIn10()?'generic-earth-intent-replaced':'generic-configured-intent-replaced';
  }else if(isEarthIn10()&&!forced){
    const conflict=earthCurrentIntentConflict(db,row);
    if(conflict){
      const idea=earthIn10Idea(db,row);
      db.prepare("UPDATE factory_items SET hook=?,story=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
        .run(idea.hook,idea.story,new Date().toISOString(),row.id);
      repaired=true;reason='earth-duplicate-intent-replaced:'+conflict.reason;
    }
  }else if(staleGenericPrompt){
    db.prepare("UPDATE factory_items SET prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
      .run(new Date().toISOString(),row.id);
    repaired=true;reason='stale-generic-prompt-cleared';
  }
  const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);
  if(!fresh||isGenericAutonomousIdea(fresh.hook,fresh.story))throw new Error('CONTENT_GATE: concrete episode intent required before Flow generation.');
  if(isEarthIn10()){
    const conflict=earthCurrentIntentConflict(db,fresh);
    if(conflict)throw new Error('CONTENT_GATE: EARTH_DUPLICATE_LANDSCAPE_BLOCKED:'+conflict.reason+':other_episode='+conflict.other.episode);
  }
  return{row:fresh,repaired,reason};
}


function sha256(v){return createHash('sha256').update(String(v)).digest('hex');}
function creativePackageDigest(row,prompt,title,description){
  return sha256(JSON.stringify({
    episode:Number(row?.episode||0),
    hook:String(row?.hook||''),
    story:String(row?.story||''),
    prompt:String(prompt||''),
    title:String(title||''),
    description:String(description||'')
  }));
}
export function validateEpisodePrompt(row,prompt){
  const bible=String(CONFIG.content.creative_bible||'').trim();
  const p=String(prompt||'').trim();
  if(bible.length<20)throw new Error('SHOW_BIBLE_REQUIRED: no episode may be generated without a configured Show Bible.');
  if(p.length<400)throw new Error('PROMPT_QUALITY_GATE: prompt is empty or too short.');
  if(!p.includes('CREATIVE BIBLE')||!p.includes(bible))throw new Error('PROMPT_QUALITY_GATE: prompt does not contain the active Show Bible.');
  if(!p.includes('HOOK: '+String(row?.hook||'')))throw new Error('PROMPT_QUALITY_GATE: prompt is not bound to the episode hook.');
  if(!p.includes('EPISODE INTENT: '+String(row?.story||'')))throw new Error('PROMPT_QUALITY_GATE: prompt is not bound to the episode story.');
  if(
    /HOOK:\s*NEXT CHAPTER/i.test(p)||
    /EPISODE INTENT:\s*Continue the configured Creative Bible and canon from the previous accepted beat/i.test(p)
  )throw new Error('CONTENT_GATE: internal planner placeholder blocked before Flow.');
  return true;
}
export function materializeCreativePackage(db,row,{force=false}={}){
  const intent=enforceEpisodeIntent(db,row);
  row=intent.row;
  const existingPrompt=String(row?.prompt||'');
  const existingTitle=String(row?.title||'');
  const existingDescription=String(row?.description||'');
  const existingDigest=existingPrompt&&existingTitle&&existingDescription
    ? creativePackageDigest(row,existingPrompt,existingTitle,existingDescription)
    : '';
  if(!force&&existingPrompt&&existingTitle&&existingDescription&&
     String(row?.creativePackageHash||'')===existingDigest){
    try{
      validateEpisodePrompt(row,existingPrompt);
      const providers=CONFIG.publication?.providers||[],provider=providers.find(x=>x.type===CONFIG.publication?.selected_provider)||providers[0]||{};
      const expected=buildPublicationCopy({
        hook:row.hook,
        story:row.story,
        prompt:existingPrompt,
        contextTerms:[],
        hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
        showName:CONFIG.identity?.show_name||SHOW,
        maxTitleLength:100
      });
      let expectedDescription=String(expected.description||'');
      while(Buffer.byteLength(expectedDescription,'utf8')>4800)expectedDescription=expectedDescription.slice(0,-30).trimEnd();
      const expectedTitle=String(expected.title||'').slice(0,100);
      if(existingTitle!==expectedTitle||existingDescription!==expectedDescription)force=true;
      else return{row,repaired:intent.repaired,reason:intent.reason,created:false};
    }catch{
      force=true;
    }
  }

  const visual=resolveVisualCharacters(row);
  const prompt=buildPrompt(db,row,visual);
  validateEpisodePrompt(row,prompt);
  const providers=CONFIG.publication?.providers||[],provider=providers.find(x=>x.type===CONFIG.publication?.selected_provider)||providers[0]||{};
  const copy=buildPublicationCopy({
    hook:row.hook,
    story:row.story,
    prompt,
    contextTerms:[],
    hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
    showName:CONFIG.identity?.show_name||SHOW,
    maxTitleLength:100
  });
  let description=String(copy.description||'');
  while(Buffer.byteLength(description,'utf8')>4800)description=description.slice(0,-30).trimEnd();
  const title=String(copy.title||'').slice(0,100);
  if(!title.trim()||!description.trim())throw new Error('CREATIVE_PACKAGE_METADATA_EMPTY');
  const promptHash=sha256(prompt),packageHash=creativePackageDigest(row,prompt,title,description),packageId='creative-package-v2-'+randomUUID();
  const roles=visual.map(name=>({name,role:'ON_SCREEN',visual:true}));
  const registryData=registry();
  const handles=visual.map(name=>registryData.characters.find(x=>String(x.name)===String(name))?.mention||('@'+name));

  db.prepare("UPDATE factory_items SET prompt=?,promptHash=?,promptGenerationId=?,characterHandles=?,characterRoles=?,promptPayloadHash=?,promptPayloadLength=?,title=?,description=?,creativePackageHash=?,creativePackageId=?,updatedAt=? WHERE id=?")
    .run(prompt,promptHash,'runtime-package-v2-'+randomUUID(),JSON.stringify(handles),JSON.stringify(roles),promptHash,Buffer.byteLength(prompt,'utf8'),title,description,packageHash,packageId,new Date().toISOString(),row.id);

  const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);
  if(!fresh||!String(fresh.prompt||'').trim())throw new Error('PROMPT_QUALITY_GATE: prompt persistence failed.');
  validateEpisodePrompt(fresh,fresh.prompt);
  return{row:fresh,repaired:intent.repaired,reason:intent.reason,created:true};
}

export function ideaForEpisode(episode){
  const i=Number(episode)-1,initial=CONFIG.content.initial_episodes[i];
  if(initial){
    if(Array.isArray(initial))return{hook:String(initial[0]||('EPISODE '+episode)),story:String(initial[1]||'')};
    return{hook:String(initial.hook||initial.title||('EPISODE '+episode)),story:String(initial.story||initial.intent||initial.description||'')};
  }
  const seeds=CONFIG.content.autonomous_seed_ideas;
  if(seeds.length){
    // Autonomous seeds begin AFTER all explicitly configured initial episodes.
    // Using the absolute episode index skipped the first seeds (E4 started at
    // seed #4 when three initial episodes existed), breaking serialized canon.
    const seedIndex=Math.max(0,Number(episode)-CONFIG.content.initial_episodes.length-1);
    const v=seeds[seedIndex%seeds.length],cycle=Math.floor(seedIndex/seeds.length)+1;
    const cycleSuffix=cycle>1?' Continuation cycle '+cycle+'. Preserve canon and create a new consequence rather than repeating the previous episode.':'';
    if(typeof v==='string')return{hook:'NEW TURN',story:v+cycleSuffix};
    return{hook:String(v.hook||'NEW TURN'),story:String(v.story||v.intent||'')+cycleSuffix};
  }
  if(isEarthIn10()){
    const v=earthIn10Idea(episode);
    return{hook:v.hook,story:v.story};
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
  const drafts=db.prepare("SELECT * FROM factory_items WHERE status='draft' ORDER BY episode").all();
  const dinnieShow=/dinnie\s*(?:the\s*)?dinosaur|dinnie/i.test(String(SHOW||CONFIG.identity?.show_name||''));
  for(let row of drafts){
    if(dinnieShow&&Number(row.episode)>CONFIG.content.initial_episodes.length){
      const expected=ideaForEpisode(Number(row.episode));
      if(expected&&(String(row.hook||'')!==String(expected.hook||'')||String(row.story||'')!==String(expected.story||''))){
        db.prepare("UPDATE factory_items SET hook=?,story=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
          .run(String(expected.hook||''),String(expected.story||''),new Date().toISOString(),row.id);
        row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row;
      }
    }
    const force=isGenericAutonomousIdea(row.hook,row.story)||/HOOK:\s*NEXT CHAPTER/i.test(String(row.prompt||''))||/EPISODE INTENT:\s*Continue the configured Creative Bible and canon from the previous accepted beat/i.test(String(row.prompt||''));
    materializeCreativePackage(db,row,{force});
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
