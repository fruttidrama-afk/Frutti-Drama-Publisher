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

function titleCaseWords(v){
  return normalize(v).toLowerCase().replace(/\b([a-záéíóúñ])/g,m=>m.toUpperCase());
}
function sharedWordRun(a,b,minWords=6){
  const A=normalize(a).toLowerCase().split(/\s+/).filter(Boolean);
  const B=normalize(b).toLowerCase().split(/\s+/).filter(Boolean);
  const hay=' '+B.join(' ')+' ';
  for(let n=Math.min(14,A.length);n>=minWords;n--){
    for(let i=0;i+n<=A.length;i++)if(hay.includes(' '+A.slice(i,i+n).join(' ')+' '))return A.slice(i,i+n).join(' ');
  }
  return'';
}
function dinnieFacts(story='',hook=''){
  const s=(normalize(story)+' '+normalize(hook)).toLowerCase();
  return{
    trail:/trail|path|road|stepping stone/.test(s),
    vanish:/vanish|disappear|dissolv|fade|break apart/.test(s),
    home:/home|forest|prehistoric/.test(s),
    land:/land|descend|float down|return/.test(s),
    seed:/seed/.test(s),
    door:/door|gate|arch|threshold/.test(s),
    open:/open|unlock|reveal/.test(s),
    star:/star|starlight|constellation/.test(s),
    bridge:/bridge/.test(s),
    comet:/comet/.test(s),
    pool:/pool|mirror/.test(s),
    portal:/portal|another world|new world/.test(s),
    flower:/flower|petal|blossom/.test(s),
    cloud:/cloud/.test(s),
    stair:/stair|staircase/.test(s),
    bell:/bell|chime/.test(s),
    rainbow:/rainbow/.test(s),
    acorn:/acorn/.test(s),
    tree:/tree|trunk/.test(s),
    island:/island/.test(s),
    moon:/moon/.test(s),
    light:/glow|light|luminous|spark/.test(s)
  };
}
function dinnieDynamicTitle(story='',hook=''){
  const f=dinnieFacts(story,hook);
  if(f.trail&&f.vanish)return"Dinnie’s Glowing Path Vanishes ✨🦕!";
  if(f.door&&f.open&&f.star)return"Dinnie Opens a Door to Starlight ⭐✨!";
  if(f.home&&f.seed)return"A Tiny Star-Seed Finds Dinnie ⭐🦕!";
  if(f.bridge&&f.star)return"A Bridge of Stars Appears for Dinnie ✨🦕!";
  if(f.comet)return"A Tiny Comet Leads Dinnie ☄️🦕!";
  if(f.pool&&f.portal)return"The Mirror Pool Hides Another World ✨🦕!";
  if(f.flower&&f.cloud)return"Dinnie Finds a World of Flower Clouds 🌸🦕!";
  if(f.stair&&f.flower)return"A Stairway of Blossoms Appears 🌼🦕!";
  if(f.bell)return"Dinnie Rings a Magical Petal Bell 🔔🌸!";
  if(f.rainbow)return"Dinnie Rides a Rainbow Through the Sky 🌈🦕!";
  if(f.acorn&&f.tree)return"A Glowing Acorn Opens a Secret 🌰✨!";
  if(f.door&&f.home)return"Dinnie Finds a Door Back Home 🦕✨!";
  if(f.moon&&f.door)return"What’s Beyond the Moon Archway? 🌙🦕";
  const h=titleCaseWords(normalize(hook).replace(/^THE\s+/i,'').replace(/^DINNIE\s+/i,'').replace(/\bNEXT CHAPTER\b/ig,'').trim());
  return h?(`Dinnie’s ${h} ✨🦕!`):"Dinnie Discovers Something Magical ✨🦕!";
}
function dinnieDynamicCaption(story='',hook=''){
  const f=dinnieFacts(story,hook);
  let first='Dinnie follows a gentle magical surprise into the next part of her adventure.';
  if(f.trail&&f.vanish)first='Dinnie’s glowing route suddenly disappears, turning the journey into a soft, dreamy surprise.';
  else if(f.door&&f.open&&f.star)first='A mysterious doorway comes alive for Dinnie and reveals a dazzling starlit world on the other side.';
  else if(f.home&&f.seed)first='Back in her warm prehistoric forest, Dinnie notices a tiny star-like seed glowing nearby.';
  else if(f.bridge&&f.star)first='The night sky seems to build Dinnie a sparkling bridge, one bright point at a time.';
  else if(f.comet)first='A playful little comet becomes Dinnie’s guide and leads her toward a new mystery.';
  else if(f.pool&&f.portal)first='A shimmering pool changes before Dinnie’s eyes and begins to look like a doorway to somewhere impossible.';
  else if(f.flower&&f.cloud)first='Dinnie wanders into a dreamy sky filled with soft flowers, drifting petals and glowing magic.';
  else if(f.stair&&f.flower)first='A cloud of blossoms rises around Dinnie and turns itself into a staircase toward something new.';
  else if(f.bell)first='One tiny touch from Dinnie sends a magical chime across the whole world around her.';
  else if(f.rainbow)first='Dinnie catches a glowing rainbow current and glides through the sky toward her next surprise.';
  else if(f.acorn&&f.tree)first='A glowing acorn reacts to Dinnie and reveals a secret that was hidden in plain sight.';
  else if(f.door&&f.home)first='A warm little doorway gives Dinnie a glimpse of home again—but the adventure is not quite finished.';

  let second='The final seconds reveal a fresh clue that keeps the story moving forward.';
  if(f.door&&f.star)second='Beyond it, floating lights and a distant shape invite her to keep exploring.';
  else if(f.seed&&f.door)second='Its light points toward an ancient doorway that looks ready to wake up.';
  else if(f.bridge&&f.moon)second='At the far end, a moon-shaped arch begins to glow as if it has been waiting for her.';
  else if(f.comet&&f.pool)second='At the top of the trail, a strange reflective pool hints at an entirely different place.';
  else if(f.pool&&f.portal)second='A new world appears inside the reflection, leaving Dinnie right at the edge of the next chapter.';
  else if(f.flower&&f.door)second='A floating garden entrance waits ahead, promising another gentle surprise.';
  else if(f.stair&&f.bell)second='At the top, a delicate little bell is waiting for Dinnie to discover it.';
  else if(f.bell&&f.rainbow)second='The chime answers by painting a glowing rainbow route across the sky.';
  else if(f.rainbow&&f.island)second='A strange little island appears in the distance, giving Dinnie a brand-new destination.';
  else if(f.acorn&&f.tree)second='A tiny tree springs to life and opens a warm light-filled doorway in its trunk.';
  else if(f.home&&f.light)second='Just when everything feels familiar again, a new sparkle hints that another adventure is beginning.';
  return first+' ✨🦕 '+second;
}
function dinnieCopy({hook='',story='',prompt=''}={}){
  const narrative=normalize(story)||extractPromptIntent(prompt);
  const title=dinnieDynamicTitle(narrative,hook);
  let description=dinnieDynamicCaption(narrative,hook);
  if(sharedWordRun(description,narrative,6)||sharedWordRun(description,extractPromptIntent(prompt),6)){
    description='Dinnie follows a magical clue into a brand-new surprise. ✨🦕 The last moment reveals just enough to make the next adventure impossible to ignore.';
  }
  return{title,desc:description.replace(/\s+/g,' ').trim()};
}
function extractPromptIntent(prompt=''){
  const p=String(prompt||'').replace(/\r/g,'').trim();
  if(!p)return'';
  // The explicit per-episode intent is authoritative. The full production prompt
  // also embeds the Show Bible, which may contain examples from older episodes
  // (such as Patagonia). Never let an example sentence earlier in the Bible win.
  const intent=p.match(/EPISODE INTENT:\s*([^\n]+)/i);
  if(intent?.[1]&&!genericEpisodeText(intent[1]))return normalize(intent[1]);
  const direct=p.match(/Create\s+(?:an?|the)?[^\n.]*?video\s+of\s+([^\n.]+)[.]/i);
  if(direct?.[1])return normalize(direct[1]);
  const story=p.match(/\nSTORY\s*\n([\s\S]*?)(?:\nBEATS\s*\/\s*TIMING|\nCAMERA|\nLIGHTING)/i);
  if(story?.[1]){
    const cleaned=normalize(story[1].replace(/HOOK:\s*[^\n]+/i,'').replace(/EPISODE INTENT:\s*/i,''));
    if(cleaned&&!genericEpisodeText(cleaned))return cleaned;
  }
  return'';
}
function earthKnownCopy({prompt='',hook='',story='',contextTerms=[]}={}){
  // Database hook/story are the episode's canonical intent. Prompt text contains the
  // full Show Bible and can mention previous/example locations, so prompt is fallback only.
  const intent=extractPromptIntent(prompt);
  const canonical=normalize([!genericEpisodeText(story)?story:'',!genericEpisodeText(hook)?hook:''].filter(Boolean).join(' ')).toLowerCase();
  const promptIntent=normalize(intent).toLowerCase();
  const fallback=normalize(Array.isArray(contextTerms)?contextTerms:[]).toLowerCase();
  const hay=canonical||promptIntent||fallback;
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
function shortenClosed(s,max){
  let out=shortenComplete(s,max);
  while(out&&!hasClosedEnding(out+'.')){
    const next=out.replace(/\s+\S+$/,'').replace(/[,:;\-]+$/,'').trim();
    if(!next||next===out)break;
    out=next;
  }
  return out||'A cinematic Earth landscape';
}
function earthFallbackTitle({hook,story,prompt,maxTitleLength}){
  const intent=extractPromptIntent(prompt);
  const source=(!genericEpisodeText(story)?normalize(story):'')||intent;
  const cleanHook=!genericEpisodeText(hook)?normalize(hook).toUpperCase():'EARTH IN 10';
  let core='';
  if(source){
    const first=completeSentenceCandidates(source)[0]||source;
    core=shortenClosed(first,58);
  }
  if(!core)core='A cinematic journey through our planet';
  let t=cleanHook+': '+core.replace(/[.!?]+$/,'')+'.';
  if(t.length>maxTitleLength)t='EARTH IN 10: '+shortenClosed(core,Math.max(20,maxTitleLength-15))+'.';
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
  const dinnie=/dinnie\s*(?:the\s*)?dinosaur|dinnie/i.test(String(showName||''));
  const configured=listTags(hashtags);
  const earthDefaults=['#EarthIn10','#Nature','#Travel','#Shorts','#ViralShorts'];
  const dinnieDefaults=['#DinnieTheDinosaur','#KidsAnimation','#Reels','#Viral'];
  const allTags=listTags([...(earth?earthDefaults:[]),...(dinnie?dinnieDefaults:[]),...configured]);
  const discoveryTitleTags=earth?['#Shorts','#ViralShorts']:[];

  let title='';
  let descriptionBase='';
  if(dinnie){
    const copy=dinnieCopy({hook:cleanHook,story:cleanStory,prompt});
    title=copy.title;
    descriptionBase=copy.desc;
  }else if(earth){
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
      title=shortenClosed(noPunct,Math.max(24,room-1))+'.';
    }
    title=(title+suffix).trim();
  }
  title=validateTitleSentence(title,{maxLength:maxTitleLength});

  let description=normalize(descriptionBase);
  if(showName&&!dinnie)description+=(description?'\n\n':'')+normalize(showName);
  if(allTags.length)description+=(description?'\n\n':'')+allTags.join(' ');
  description=description.trim();
  return{title,description,plot:descriptionBase,hashtags:allTags};
}
