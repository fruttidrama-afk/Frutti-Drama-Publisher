const normalize=v=>String(v||'').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim();

function hasClosedEnding(s){
  return /[.!?]$/.test(String(s||'').trim()) && !/(?:\b(?:and|or|but|because|with|without|for|to|from|of|in|on|at|by|de|del|con|sin|por|para|a|y|o|pero|porque|que|en|un|una|el|la|los|las|su|sus))\s*[.!?]$/i.test(String(s||'').trim());
}

function completeSentenceCandidates(story){
  const clean=normalize(story);
  const sentences=clean.match(/[^.!?]+[.!?]+/g)||[];
  const out=[];
  for(const raw of sentences){
    const s=raw.replace(/\s+/g,' ').trim();
    if(hasClosedEnding(s))out.push(s);
  }
  if(!out.length&&clean){
    const s=/[.!?]$/.test(clean)?clean:clean+'.';
    if(hasClosedEnding(s))out.push(s);
  }
  return out;
}

function clauseCandidate(sentence,maxLen){
  const raw=String(sentence||'').replace(/[.!?]+$/,'').trim();
  const boundaries=[
    /,\s*(?:but|although|while|because|pero|aunque|mientras|porque)\s+/i,
    /\s+(?:and|y)\s+(?=[A-ZÁÉÍÓÚÑ]|(?:he|she|they|it|él|ella|ellos|ellas|uva|mango|fresia|limón|banana|naranja|don)\b)/i,
    /;\s*/
  ];
  for(const re of boundaries){
    const first=raw.split(re)[0]?.trim();
    if(first&&first.length>=12&&first.length<=maxLen)return first+'.';
  }
  const relative=raw.split(/\s+(?:that|which|who|que|quien|donde)\s+/i)[0]?.trim();
  if(relative&&relative.length>=12&&relative.length<=maxLen)return relative+'.';
  return null;
}

function listTags(values=[]){
  const out=[];
  for(const raw of Array.isArray(values)?values:[values]){
    const t=normalize(raw);
    if(!t)continue;
    const tag=t.startsWith('#')?t:'#'+t.replace(/\s+/g,'');
    if(!out.some(x=>x.toLowerCase()===tag.toLowerCase()))out.push(tag);
  }
  return out;
}
function genericEpisodeText(v){
  const n=normalize(v).toLowerCase();
  return !n || /^(next chapter|new turn|new episode)\b/.test(n) || /continue the configured creative bible/.test(n) || /continue .*canon from the previous accepted beat/.test(n);
}
function extractPromptIntent(prompt=''){
  const p=String(prompt||'').replace(/\r/g,'').trim();
  if(!p)return'';
  const direct=p.match(/Create\s+(?:an?|the)?[^\n.]*?video\s+of\s+([^\n.]+)[.]/i);
  if(direct?.[1])return normalize(direct[1]);
  const intent=p.match(/EPISODE INTENT:\s*([^\n]+)/i);
  if(intent?.[1]&&!genericEpisodeText(intent[1]))return normalize(intent[1]);
  const story=p.match(/\nSTORY\s*\n([\s\S]*?)(?:\nBEATS\s*\/\s*TIMING|\nCAMERA|\nLIGHTING)/i);
  if(story?.[1]){
    const cleaned=normalize(story[1].replace(/HOOK:\s*[^\n]+/i,'').replace(/EPISODE INTENT:\s*/i,''));
    if(cleaned&&!genericEpisodeText(cleaned))return cleaned;
  }
  return'';
}
function earthKnownCopy({prompt='',hook='',story='',contextTerms=[]}={}){
  // The exact episode intent is authoritative. Never let continuity/canon text from the
  // rest of the prompt, or recovery correlation terms from another asset, hijack copy.
  const intent=extractPromptIntent(prompt);
  const primary=normalize([intent,!genericEpisodeText(story)?story:'',!genericEpisodeText(hook)?hook:''].filter(Boolean).join(' ')).toLowerCase();
  const fallback=normalize(Array.isArray(contextTerms)?contextTerms:[]).toLowerCase();
  const hay=primary||fallback;
  const known=[
    {re:/patagonia|glacial lake|turquoise.*lake/,title:'PATAGONIA SUNRISE: Turquoise glacial lake beneath the Andes.',desc:'A crystal-clear turquoise glacial lake, snow-covered peaks and soft sunrise mist turn Patagonia into a cinematic ten-second escape.'},
    {re:/namib|solitary tree|red orange dunes|dead vlei|deadvlei/,title:'NAMIB DESERT: A solitary tree beneath glowing red dunes.',desc:'A solitary dark tree stands against Namibia’s immense red-orange dunes as warm sunrise light stretches across the desert.'},
    {re:/iceland|black sand|reynisfjara|basalt/,title:'ICELAND BLACK SAND: Atlantic waves meet volcanic cliffs.',desc:'Black volcanic sand, towering basalt formations and cold Atlantic surf create a dramatic cinematic glimpse of Iceland.'},
    {re:/zhangjiajie|stone pillars|quartz sandstone/,title:'ZHANGJIAJIE MIST: Stone pillars rise above the clouds.',desc:'Mist drifts between the towering sandstone pillars of Zhangjiajie, revealing one of China’s most surreal natural landscapes.'},
    {re:/uyuni|salt flat|salar/,title:'UYUNI MIRROR: Bolivia’s salt flat becomes the sky.',desc:'A thin layer of water transforms Salar de Uyuni into a vast natural mirror at sunrise, blending horizon and sky.'},
    {re:/dolomites|italy.*mountain/,title:'DOLOMITES DAWN: Alpine peaks ignite with morning light.',desc:'Warm dawn light touches the jagged Dolomite peaks while quiet alpine valleys stretch beneath them.'},
    {re:/faroe|faroe islands|waterfall.*ocean/,title:'FAROE ISLANDS: Waterfalls fall straight into the Atlantic.',desc:'Steep green cliffs, ocean mist and dramatic waterfalls reveal the raw scale of the Faroe Islands.'},
    {re:/lencois|lençóis|maranhenses/,title:'LENÇÓIS MARANHENSES: Blue lagoons between endless dunes.',desc:'Seasonal blue lagoons appear between sweeping white dunes in Brazil’s extraordinary Lençóis Maranhenses.'}
  ];
  return known.find(x=>x.re.test(hay))||null;
}
function shortenComplete(s,max){
  const clean=normalize(s).replace(/[.!?]+$/,'').trim();
  if(clean.length<=max)return clean;
  const words=clean.split(' ');
  let out='';
  for(const w of words){
    const next=(out?out+' ':'')+w;
    if(next.length>max)break;
    out=next;
  }
  return out.replace(/[,:;\-]+$/,'').trim();
}
function earthFallbackTitle({hook,story,prompt,maxTitleLength}){
  const intent=extractPromptIntent(prompt);
  const source=intent||(!genericEpisodeText(story)?normalize(story):'');
  const cleanHook=!genericEpisodeText(hook)?normalize(hook).toUpperCase():'EARTH IN 10';
  let core='';
  if(source){
    const first=completeSentenceCandidates(source)[0]||source;
    core=shortenComplete(first,58);
  }
  if(!core)core='A cinematic journey through our planet';
  let t=cleanHook+': '+core.replace(/[.!?]+$/,'')+'.';
  if(t.length>maxTitleLength)t='EARTH IN 10: '+shortenComplete(core,Math.max(20,maxTitleLength-15))+'.';
  return t;
}

export function validateTitleSentence(title,{maxLength=100}={}){
  const t=normalize(title);
  if(!t)throw new Error('Publication title is empty.');
  if(t.length>maxLength)throw new Error('Publication title exceeds '+maxLength+' characters.');
  if(/\.\.\.|…/.test(t))throw new Error('Publication title must never be truncated with ellipsis.');
  const withoutTags=t.replace(/(?:\s+#[A-Za-z0-9_]+)+\s*$/,'').trim();
  const afterColon=(withoutTags.includes(':')?withoutTags.slice(withoutTags.indexOf(':')+1):withoutTags).trim();
  if(!hasClosedEnding(afterColon))throw new Error('Publication title must end as a complete sentence or phrase, not an open clause.');
  return t;
}

export function buildPublicationCopy({hook,story,prompt='',contextTerms=[],hashtags=[],showName='',maxTitleLength=100}={}){
  const cleanHook=normalize(hook||'NEW EPISODE').toUpperCase();
  const cleanStory=normalize(story);
  const earth=/earth\s*in\s*10/i.test(String(showName||''));
  const configured=listTags(hashtags);
  const earthDefaults=['#EarthIn10','#Nature','#Travel','#Shorts','#ViralShorts'];
  const allTags=listTags([...(earth?earthDefaults:[]),...configured]);
  const discoveryTitleTags=earth?['#Shorts','#ViralShorts']:[];

  let title='';
  let descriptionBase='';
  if(earth){
    const known=earthKnownCopy({prompt,hook:cleanHook,story:cleanStory,contextTerms});
    if(known){title=known.title;descriptionBase=known.desc}
    else{
      title=earthFallbackTitle({hook:cleanHook,story:cleanStory,prompt,maxTitleLength});
      const intent=extractPromptIntent(prompt);
      descriptionBase=intent||(!genericEpisodeText(cleanStory)&&cleanStory?cleanStory:'')||'A cinematic ten-second glimpse of one of Earth’s extraordinary landscapes.';
    }
  }else{
    const prefix=cleanHook?cleanHook+': ':'';
    const room=Math.max(18,maxTitleLength-prefix.length);
    const sentences=completeSentenceCandidates(cleanStory);
    let core=sentences.find(s=>s.length<=room)||null;
    if(!core&&sentences.length)core=clauseCandidate(sentences[0],room);
    if(!core){
      const intent=extractPromptIntent(prompt);
      if(intent)core=(completeSentenceCandidates(intent)[0]||intent.replace(/[.!?]*$/,'.'));
    }
    if(!core)throw new Error('Could not derive a complete factual title from the episode story or prompt without truncation.');
    title=prefix+core;
    if(title.length>maxTitleLength){
      const shorter=sentences.find(s=>s.length<=maxTitleLength);
      if(!shorter)throw new Error('Could not fit a complete factual title within the platform limit.');
      title=shorter;
    }
    descriptionBase=cleanStory||extractPromptIntent(prompt);
  }

  if(discoveryTitleTags.length){
    const suffix=' '+discoveryTitleTags.join(' ');
    const room=maxTitleLength-suffix.length;
    title=title.replace(/\s+#[A-Za-z0-9_]+/g,'').trim();
    if(title.length>room){
      const noPunct=title.replace(/[.!?]+$/,'');
      title=shortenComplete(noPunct,Math.max(24,room-1))+'.';
    }
    title=(title+suffix).trim();
  }
  title=validateTitleSentence(title,{maxLength:maxTitleLength});

  let description=normalize(descriptionBase);
  if(showName)description+=(description?'\n\n':'')+normalize(showName);
  if(allTags.length)description+=(description?'\n\n':'')+allTags.join(' ');
  description=description.trim();
  return{title,description,plot:descriptionBase,hashtags:allTags};
}
