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

export function validateTitleSentence(title,{maxLength=100}={}){
  const t=normalize(title);
  if(!t)throw new Error('Publication title is empty.');
  if(t.length>maxLength)throw new Error('Publication title exceeds '+maxLength+' characters.');
  if(/\.\.\.|…/.test(t))throw new Error('Publication title must never be truncated with ellipsis.');
  const afterColon=(t.includes(':')?t.slice(t.indexOf(':')+1):t).trim();
  if(!hasClosedEnding(afterColon))throw new Error('Publication title must end as a complete sentence or phrase, not an open clause.');
  return t;
}

export function buildPublicationCopy({hook,story,hashtags=[],showName='',maxTitleLength=100}={}){
  const cleanHook=normalize(hook||'NEW EPISODE').toUpperCase();
  const cleanStory=normalize(story);
  const prefix=cleanHook?cleanHook+': ':'';
  const room=Math.max(18,maxTitleLength-prefix.length);
  const sentences=completeSentenceCandidates(cleanStory);
  let core=sentences.find(s=>s.length<=room)||null;
  if(!core&&sentences.length)core=clauseCandidate(sentences[0],room);
  if(!core)throw new Error('Could not derive a complete factual title from the episode story without truncation.');
  let title=prefix+core;
  if(title.length>maxTitleLength){
    const shorter=sentences.find(s=>s.length<=maxTitleLength);
    if(!shorter)throw new Error('Could not fit a complete factual title within the platform limit.');
    title=shorter;
  }
  title=validateTitleSentence(title,{maxLength:maxTitleLength});
  const tags=Array.isArray(hashtags)?hashtags.map(normalize).filter(Boolean).join(' '):normalize(hashtags);
  let description=cleanStory;
  if(showName)description+=(description?'\n\n':'')+normalize(showName);
  if(tags)description+=(description?'\n\n':'')+tags;
  description=description.trim();
  return{title,description,plot:cleanStory};
}
