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
    for(let i=0;i+n<=A.length;i++){
      if(hay.includes(' '+A.slice(i,i+n).join(' ')+' '))return A.slice(i,i+n).join(' ');
    }
  }
  return'';
}
function dinnieNarrativeCaption(key,story=''){
  const known={
    'THE TRAIL DISAPPEARS':"Dinnie’s sparkling path suddenly fades away, turning the trip home into a soft magical descent through the clouds. ✨🦕 A familiar golden forest is waiting below…",
    'DINNIE COMES HOME':"Dinnie is finally back in her warm prehistoric forest—but a tiny glowing star-seed has another adventure in mind. ⭐🦕 Its light leads her straight to a mysterious ancient door.",
    'THE STAR DOOR OPENS':"A tiny star unlocks the stone door, and Dinnie gets her first glimpse of a dazzling world beyond the forest. ⭐✨ Floating lights, a glowing path and a moon-shaped arch are calling her forward.",
    'FIRST STEP INTO STARLIGHT':"Dinnie crosses the threshold into the starlight world, where every step seems to wake the sky around her. ⭐🦕 Then a bridge made of constellations begins forming ahead.",
    'THE CONSTELLATION BRIDGE':"The stars build Dinnie a bridge one glowing step at a time. ✨🦕 At the other side, a moon-shaped arch suddenly comes to life.",
    'MOON ARCHWAY SECRET':"Dinnie slips through the glowing moon arch and discovers that everything feels lighter on the other side. 🌙✨ A tiny comet appears—and it wants her to follow.",
    'THE COMET TRAIL':"A playful little comet guides Dinnie up a silver hill toward something hidden at the top. ☄️🦕 What she finds there looks like a pool… but reflects a completely different sky.",
    'THE MIRROR POOL':"Dinnie touches the mysterious mirror pool and rings of light race across its surface. ✨🦕 In seconds, the water reveals a portal to a brand-new magical world.",
    'FLOWER CLOUDS AHEAD':"Dinnie steps into a dreamy world of flower clouds, drifting petals and glowing pollen-light. 🌸🦕 A floating garden gate waits at the end of the path.",
    'THE FLOATING GARDEN GATE':"The floating garden gate opens for Dinnie—and thousands of tiny blossoms rise into the air. 🌸✨ Together they create a staircase leading higher into the clouds.",
    'STAIRWAY OF BLOSSOMS':"Dinnie climbs a staircase made of glowing flowers, lighting each step as she goes. 🌼🦕 At the very top, a delicate petal bell is waiting.",
    'THE PETAL BELL':"One gentle tap on the petal bell sends a magical chime across the entire flower-cloud world. 🔔🌸 Then a rainbow current appears in the sky.",
    'RIDING THE RAINBOW CURRENT':"Dinnie hops onto a soft ribbon of rainbow light and glides across the sky. 🌈🦕 Her destination? A strange little island shaped like a glowing acorn.",
    'THE GLOWING ACORN':"A giant glowing acorn hides a wonderful surprise for Dinnie. 🌰✨ One touch makes a tiny tree spring to life—and a warm doorway opens inside its trunk.",
    'A DOOR BACK HOME':"Dinnie peers through the little tree-door and sees her golden prehistoric forest again. 🦕✨ She makes it home… just as a new sparkle appears high above the trees."
  };
  if(known[key])return known[key];

  const s=normalize(story).toLowerCase();
  const motifs=[];
  if(/door|gate|arch/.test(s))motifs.push('a mysterious glowing doorway');
  if(/bridge|path|trail/.test(s))motifs.push('a magical path');
  if(/star|constellation|starlight/.test(s))motifs.push('a sky full of living starlight');
  if(/cloud|flower|petal|blossom/.test(s))motifs.push('a dreamy world in the clouds');
  if(/comet/.test(s))motifs.push('a tiny comet guide');
  if(/pool|mirror/.test(s))motifs.push('a shimmering portal');
  if(/rainbow/.test(s))motifs.push('a ribbon of rainbow light');
  if(/home|forest/.test(s))motifs.push('her warm prehistoric home');
  const first=motifs[0]||'a brand-new magical surprise';
  const second=motifs[1]||'a clue to where the adventure goes next';
  return `Dinnie discovers ${first}, and one tiny moment changes the whole adventure. ✨🦕 Before she can settle in, ${second} appears.`;
}
function dinnieCopy({hook='',story='',prompt=''}={}){
  const key=normalize(hook).toUpperCase();
  const knownTitles={
    'THE TRAIL DISAPPEARS':'The Sugar-Dust Trail Disappears ✨🦕!',
    'DINNIE COMES HOME':'Dinnie Floats Back Home 🦕✨!',
    'THE STAR DOOR OPENS':'The Star Door Opens ⭐🦕!',
    'FIRST STEP INTO STARLIGHT':'Dinnie Steps Into Starlight ⭐🦕!',
    'THE CONSTELLATION BRIDGE':'The Constellation Bridge ✨🦕!',
    'MOON ARCHWAY SECRET':'The Secret Beyond the Moon Archway 🌙🦕!',
    'THE COMET TRAIL':'Dinnie Follows the Comet Trail ☄️🦕!',
    'THE MIRROR POOL':'The Mirror Pool Awakens ✨🦕!',
    'FLOWER CLOUDS AHEAD':'A World of Flower Clouds 🌸🦕!',
    'THE FLOATING GARDEN GATE':'The Floating Garden Gate 🌸✨!',
    'STAIRWAY OF BLOSSOMS':'Dinnie Climbs the Blossom Stairway 🌼🦕!',
    'THE PETAL BELL':'The Magical Petal Bell 🔔🌸!',
    'RIDING THE RAINBOW CURRENT':'Dinnie Rides the Rainbow Current 🌈🦕!',
    'THE GLOWING ACORN':'The Glowing Acorn Secret ✨🌰!',
    'A DOOR BACK HOME':'A Magical Door Back Home 🦕✨!'
  };
  const title=knownTitles[key]||((titleCaseWords(key||'Dinnie’s Next Adventure'))+' ✨🦕!');
  let description=dinnieNarrativeCaption(key,story||extractPromptIntent(prompt));
  // Publication copy may be inspired by narrative facts, but it must never be a
  // pasted slice of the production prompt/story. Fail closed to a semantic,
  // hook-led caption if a long verbatim run survives.
  if(sharedWordRun(description,story,6)||sharedWordRun(description,extractPromptIntent(prompt),6)){
    description=`A new surprise changes Dinnie’s adventure in “${title.replace(/[!✨🦕⭐🌙☄️🌸🌼🔔🌈🌰]+/g,'').trim()}”. ✨🦕 Watch closely—the final moment reveals where her journey is headed next.`;
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
function earthFallbackTitle({hook,story,prompt,maxTitleLength}){
  const intent=extractPromptIntent(prompt);
  const source=(!genericEpisodeText(story)?normalize(story):'')||intent;
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
      title=shortenComplete(noPunct,Math.max(24,room-1))+'.';
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
