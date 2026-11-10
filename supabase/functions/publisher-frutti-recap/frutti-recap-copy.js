// FruttiDrama's historical hook + episode story + editorial synopsis approach.
// Reconstructed videos: take ONLY the operator-supplied current episode, never inferred canon.
// No AI API, no credits, no keys, no network, no publication or stock modifications.
const TAGS="#Shorts #ViralShorts #FruttiDrama";
const PEOPLE=/\b(?:Don Mel[oó]n|Lim[oó]n(?: Duarte)?|Uva(?: Reyes)?|Mango(?: Del Rio)?|Fresia|Banana|Bananita|Naranja)\b/gi;
const TECH=/\b(?:9:16|720p|1080p|one continuous|unbroken take|lighting|camera|cinematography|cinematic|framing|shot change|lens|character reference|reference sheet|glitch|subtitles|no duplicates|assets?|lip.?sync|audio ambience|foreground|background|portrait orientation|voice assignment|frame rate|negative prompt|idioma:|constraints:|model intent|exactly one|render this exact|visual style|soft lighting|color grading|plano|iluminaci[oó]n|c[aá]mara|encuadre|sin duplicados)\b/i;
const ACT=/(?:enfrenta|confronta|encara|confronts?|faces?|discute|discuss(?:es|ing)?|argues?|advierte|warns?|amenaza|threatens?|besa|besan|kiss(?:es|ed)?|tries to kiss|intenta besar|embaraz\w*|pregnan\w*|le cuenta|hace creer|envenena|poisons?|muere|dies|fallece|da a luz|gives birth|nace|humilla|insulta|humiliates?|insults?|revela|reveals?|confiesa|confesses?|admite|admits?|descubre|discovers?|encuentra|finds?|escucha|overhears?|rechaza|rejects?|refuses?|se niega|promete|promises?|miente|lies?|deceives?|enga[ñn]a|observa|watches?|ve a|sees?|irrumpe|interrumpe|interrupts?|aparece|arrives?|enters?|abandona|leaves?|walks away|expulsa|throws out|le dice|tells?|says?|anuncia|announces?|muestra|shows?|entrega|hands?|llora|cries|acusa|accuses?|celos|jealous|speaks?|speaking|speak to|asks?|asking|replies?|replying|responds?|retorts?|whispers?|shouts?|taunts?|accus(?:es|ing|ation)|reassures?|demands?|insists?|interrupt(?:s|ed)?|returns?|steps? in|steps? between|steps? away|walks? (?:out|away|into)|storms? (?:out|in)|pleads?|begs?|blames?|confirms?|announc(?:es|ed)|refutes?|disputes?|provok(?:es|ed)|provoca|responde|pregunta|asegura|insiste|le exige|increpa|confirma|responde a|retira|se aleja|se interpone)\b/i;
const STOP=/^(?:CREATIVE BIBLE|SHOW BIBLE|CANON|CONTINUITY|REFERENCE|REFERENCES|VISUAL|CHARACTER|AUDIO|VOICE|CAMERA|LIGHTING|NEGATIVE|ANTI.GLITCH|DIALOGUE RULES|NARRATIVE NOVELTY|RESTRICTIONS|CONSTRAINTS|IDIOMA|LANGUAGE|GENERATION|TECHNICAL|SOUND DESIGN|RULES|ASSET LOCK|EMOTION|CINEMATOGRAPHY|END STATE|BEATS\s*\/\s*TIMING)\b/i;
const HEADING=/^(?:EPISODE|EPISODIO(?: ACTUAL)?|STORY|TRAMA(?: DEL EPISODIO)?|PLOT|SINOPSIS|EPISODE STORY|HISTORIA DEL EPISODIO|DRAMATIC ACTION|ESCENA PRINCIPAL)\s*[:：]?\s*$/i;
const clean=s=>String(s||"").replace(/\s+/g," ").trim();
const identity=s=>clean(s).replace(/\s+(?:Duarte|Reyes|Del Rio)\b/gi,"").replace(/^Mel[oó]n$/i,"Don Melón");
function names(line){
 const seen=[];
 for(const match of String(line).matchAll(PEOPLE)){
  const p=identity(match[0]);
  if(!seen.some(n=>n.toLocaleLowerCase("es")===p.toLocaleLowerCase("es")))seen.push(p);
 }
 return seen;
}
// This is an interpreter of actual Flow generation prose, NOT a search for a
// compulsory 'EPISODE' header. Google Flow prompts often tell the drama inside
// shot/beat timing and character dialogue. Previous versions wrongly discarded
// complete paragraphs whenever they contained one technical word.
function extract(raw){
 const original=String(raw||"").replace(/\r/g,"");
 if(original.length<20)return {error:"STORY_NOT_FOUND",detail:"Falta el prompt completo de generación."};
 const lines=original.split("\n").map(x=>x.trim()).filter(Boolean);
 const blocks=[];
 let hook="",section="neutral",lineNo=0;
 const sceneHead=/^(?:SCENE|ESCENA|SHOT|PLANO|BEAT|STORY BEAT|STORY ACTION|ON SCREEN|ACTING|ACTION|ACCI[OÓ]N|DIALOGUE|DI[AÁ]LOGO|SCRIPT|GUI[OÓ]N|TIMELINE|SEQUENCE|SECUENCIA|CHARACTER INTERACTION|DRAMATIC EVENT|DRAMATIC ACTION|CONFLICT|CONFLICTO|ESCENAS?|WHAT HAPPENS|QU[EÉ] SUCEDE|NARRATIVE)\b/i;
 const contextHead=/^(?:CANON|SHOW BIBLE|CREATIVE BIBLE|PREVIOUS EPISODE|PREVIOUSLY|BACKSTORY|ESTABLISHED|REFERENCES?|CHARACTER SHEETS?|HISTORY|CONTINUITY|BACKGROUND CANON|ANTECEDENTES)\b/i;
 const technicalHead=/^(?:CAMERA|LIGHTING|VISUALS?|AUDIO|SOUND|SFX|NEGATIVE|CONSTRAINTS|ANTI.GLITCH|RULES|ASSET|VOICE RULES|REFERENCE|LENS|FRAMING|RENDER|GENERATION|COLOR GRADING|SAFETY|IDIOMA|LANGUAGE)\b/i;
 const splitSentences=(t)=>String(t).split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÜÑ0-9“"'¿])|;\s*|\s*[•●]\s*/).map(clean).filter(Boolean);
 const push=(text,weight)=>{
  const c=clean(text).replace(/^[-–•*]+\s*/,"");
  if(c.length<20||c.length>1350)return;
  // Technical directions can coexist on a line with the actual action: split
  // sentences/clauses, do NOT reject the entire script or mark as malformed.
  for(const piece of splitSentences(c)){
   const hasNames=names(piece).length>0;
   const hasAction=ACT.test(piece);
   const dialogue=/[«“"][^»”"]{12,}[»”"]/.test(piece)||/\b(?:dialogue|line spoken|says|tells|retorts|responds|whispers|shouts|asks|afirma|responde|pregunta)\b/i.test(piece);
   const technical=(TECH.test(piece)&&!hasAction)||/^(?:only|exactly)\s+(?:Fresia|Lim[oó]n|Uva|Banana|Mango|Don Mel[oó]n)\s+(?:speaks?|is present|appears?|talks?)(?:\W|$)/i.test(piece)||/\b(?:say nothing|says nothing|remain silent|no overlap|character designs match|never duplicated)\b/i.test(piece);
   if((hasAction&&hasNames||dialogue&&hasNames||names(piece).length>=2&&/\b(?:romantic|romance|intimate|intimately|flirt(?:ing)?|tender|talk(?:ing)?|chat(?:ting)?|conversation|discuss(?:es|ing)?|convers(?:a|an|ando)|habla(?:n|ndo)?|rom[aá]ntic[oa]|[ií]ntim[oa]|coquetea(?:n|ndo)?|juntos|together)\b/i.test(piece))&&!technical)
    blocks.push({text:piece,weight:weight+(hasNames?3:0)+(hasAction?3:0)+(dialogue?1:0),index:lineNo});
  }
 };
 for(const line of lines){
  lineNo++;
  if(section==="canon"&&/^(?:HOOK|STORY|EPISODE INTENT)\s*[:：]/i.test(line))continue;
  const h=line.match(/^HOOK\s*[:：]\s*(.{3,90})$/i);
  if(h){hook=h[1].trim();continue}
  const inline=line.match(/^(?:EPISODE INTENT|EPISODE STORY|CURRENT EPISODE|EPISODIO ACTUAL|TRAMA(?: DEL EPISODIO)?|SINOPSIS|PLOT|STORY|CONFLICTO|DRAMATIC ACTION|ACTION BEAT)\s*[:：-]\s*(.{20,})$/i);
  if(inline){section="episode";push(inline[1],35);continue}
  if(HEADING.test(line)){section="episode";continue}
  if(contextHead.test(line)&&line.length<150){section="canon";continue}
  if(technicalHead.test(line)&&line.length<150){section="technical";continue}
  if(sceneHead.test(line)&&line.length<95&&(/[:：]\s*$/.test(line)||/^(?:SCENE|ESCENA|SHOT|PLANO|BEAT|ACTION|ACCI[OÓ]N|DIALOGUE|DI[AÁ]LOGO|NARRATIVE|STORY BEAT)\s*\d*$/i.test(line))){section="scene";continue}
  if(/^[-=]{3,}$/.test(line))continue;
  if(section==="canon")continue;
  if(section==="technical"){
   // A new timed scene terminates a run of production directions.
   if(/^(?:\d{1,2}\s*(?:s|sec)|\d{1,2}(?::\d{2})?\s*[-–]\s*\d|scene\s*\d+|escena\s*\d+|beat\s*\d+)\b/i.test(line)){
    section="scene";
   }else if(!(ACT.test(line)&&names(line).length&&line.length>45))continue;
  }
  const beat=line.match(/^(?:SCENE|ESCENA|BEAT|SHOT|PLANO)\s*\d+\s*[:：–-]\s*(.{16,})$/i)||
     line.match(/^\s*(?:\d+(?::\d{2})?)\s*[-–]\s*(?:\d+(?::\d{2})?)\s*(?:s|sec)?\s*[:：-]?\s*(.{16,})$/i);
  if(beat){section="scene";push(beat[1],27);continue}
  const speaker=line.match(/^(?:DIALOGUE\s*[:：]\s*)?((?:Fresia|Uva(?: Reyes)?|Lim[oó]n(?: Duarte)?|Banana|Mango(?: Del Rio)?|Don Mel[oó]n|Naranja|Bananita))(?:\s*\([^)]{1,70}\))?\s*[:：-]\s*(.{8,})$/i);
  if(speaker){
   // Preserve the *actual speech* as the dramatic event. Never describe an
   // unrelated illness mentioned in a prior CANON section as today's action.
   const speech=clean(speaker[2]);
   if(speech.length>15&&!TECH.test(speech))push(speaker[1]+" le dice: "+speech,29);
   continue;
  }
  push(line,section==="episode"?27:section==="scene"?21:section==="technical"?9:10);
 }
 blocks.sort((x,y)=>y.weight-x.weight||x.index-y.index);
 if(!blocks.length)return {error:"STORY_NOT_FOUND",detail:"No se pudo extraer un acontecimiento ni diálogo suficiente del prompt. El sistema anterior tenía un resumen 'story' aparte; para este caso podés escribir una sola frase sobre lo que sucede en el video, sin volver a copiar el prompt."};
 const chosen=blocks[0];
 // Assemble a CURRENT-EPISODE mini-story, never just a single detected verb.
 // Preserve all close dramatic beats in source order: a romantic conversation,
 // the arrival that interrupts it, and the final character reaction.
 const coherent=blocks.filter(x=>x===chosen||(
  Math.abs(x.index-chosen.index)<=8&&x.weight>=13&&!TECH.test(x.text)&&
  (names(x.text).some(n=>names(chosen.text).includes(n))||
   /\b(?:romantic|romance|flirt|conversaci[oó]n|talking|conversation|juntos|together|interrumpe|interrupts?|enters?|irrumpe|appears?|watches?|sees?|observa|presencia|reacciona|reacts?)\b/i.test(x.text))
 )).sort((a,b)=>a.index-b.index);
 const texts=[...new Set(coherent.map(x=>x.text))].slice(0,7);
 let story=clean(texts.join(" "));
 if(story.length>1800)story=story.slice(0,1800);
 const embedded=story.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+)\s*[:：]\s*(.{20,})$/);
 if(embedded){hook=hook||embedded[1];story=embedded[2]}
 if(!ACT.test(story)&&!/le dice:/.test(story))return {error:"STORY_NOT_FOUND",detail:"El prompt contiene indicaciones de producción, pero no identifiqué una acción narrativa."};
 return {story:story.slice(0,1800),hook,extract_method:chosen.weight>=27?"episode_or_dialogue":"scene_action"};
}

const RULES=[
 {key:"veneno",re:/envenena|poisons?/i,hook:"VENENO MORTAL",verb:"envenena",intro:"cruza un límite irreversible al envenenar"},
 {key:"muerte",re:/\bmuere\b|\bdies\b|fallece/i,hook:"MUERTE DEVASTADORA",verb:"muere",intro:"muere y deja a sus seres queridos enfrentando una pérdida devastadora"},
 {key:"parto",re:/da a luz|gives birth|beb[eé] nace/i,hook:"NACIMIENTO IMPACTANTE",verb:"da a luz",intro:"da a luz y sacude el equilibrio familiar"},
 {key:"beso",re:/intenta besar|tries to kiss|attempts? to kiss|\bbesa\b|\bbesan\b|\bkisses?\b/i,hook:"BESO PROHIBIDO",verb:"besa",intro:"cruza una frontera sentimental al acercarse para besar"},
 {key:"humilla",re:/humilla|insulta|humiliates?|insults?|criada atrevida/i,hook:"HUMILLACIÓN CRUEL",verb:"humilla",intro:"humilla frente a todos"},
 {key:"enfrenta",re:/confronta|enfrenta|encara|confronts?|faces? off|argues? with/i,hook:"ENFRENTAMIENTO DIRECTO",verb:"enfrenta",intro:"encara directamente"},
 {key:"amenaza",re:/amenaza|threatens?|advierte|warns?/i,hook:"ADVERTENCIA DIRECTA",verb:"advierte",intro:"lanza una advertencia a"},
 {key:"revela",re:/revela|confiesa|admite|reveals?|confesses?|admits?/i,hook:"CONFESIÓN IMPACTANTE",verb:"revela una verdad ante",intro:"decide contar una verdad ante"},
 {key:"descubre",re:/descubre|discovers?|finds? out|se entera|encuentra una prueba/i,hook:"SECRETO DESCUBIERTO",verb:"descubre algo sobre",intro:"descubre información inesperada sobre"},
 {key:"rechaza",re:/rechaza|rejects?|refuses?|se niega a volver/i,hook:"RECHAZO DEFINITIVO",verb:"rechaza a",intro:"deja clara su negativa frente a"},
 {key:"promesa",re:/promete|promises?|jura|vows?/i,hook:"PROMESA DECISIVA",verb:"le hace una promesa a",intro:"se compromete ante"},
 {key:"interrumpe",re:/interrumpe|irrumpe|interrupts?|walks? in|enters? suddenly/i,hook:"INTERRUPCIÓN INCÓMODA",verb:"interrumpe a",intro:"irrumpe en medio de una conversación de"},
 {key:"engaño",re:/enga[ñn]a|deceives?|miente|lies? to/i,hook:"MENTIRA PELIGROSA",verb:"engaña a",intro:"le oculta la verdad a"},
 {key:"escucha",re:/escucha|overhears?|eavesdrops?|oye una conversaci[oó]n/i,hook:"SECRETO ESCUCHADO",verb:"escucha a",intro:"oye una conversación de"},
 {key:"acusa",re:/acusa|accuses?|blames?/i,hook:"ACUSACIÓN DIRECTA",verb:"acusa a",intro:"señala directamente a"},
 {key:"expulsa",re:/expulsa|throws? out|echa de la hacienda/i,hook:"EXPULSIÓN DEFINITIVA",verb:"expulsa a",intro:"obliga a abandonar la hacienda a"},
 {key:"embarazo",re:/embarazad[ao]|pregnan[tc]|espera un beb[eé]/i,hook:"EMBARAZO REVELADO",verb:"revela un embarazo ante",intro:"comunica una noticia sobre un embarazo a"},
 {key:"prueba",re:/muestra|entrega|shows?|hands? over/i,hook:"PRUEBA REVELADA",verb:"le muestra una prueba a",intro:"pone una evidencia ante"},
 {key:"observar",re:/observa|watches?|presencia|sees?/i,hook:"TESTIGO INESPERADO",verb:"observa a",intro:"presencia una escena que involucra a"},
 {key:"hablar",re:/le dice|tells?|says? to|announc(?:es|ed)|speaks? to|replies?|retorts?|responds? to|asks?|insists?|taunts?|declares?|afirma|responde a|pregunta a|asegura/i,hook:"PALABRAS DECISIVAS",verb:"habla con",intro:"habla directamente con"}
];
// An interruption may have THREE roles: the person arriving, and the two
// people in a romantic conversation. A single-verb parser loses one of them.
function sceneConversation(story,actor){
 const parts=String(story).split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÜÑ])|;\s*/).filter(Boolean);
 const romance=/\b(?:romantic|romance|intimate|intimately|affectionate|flirt(?:ing)?|sweet moment|love|rom[aá]ntic(?:o|a|os|as|amente)|romantically|[ií]ntim[oa]s?|coquetea(?:n|ndo)?|enamorad[oa]s?)\b/i;
 const talking=/\b(?:conversation|talk(?:ing)?|chat(?:ting)?|speak(?:ing)?|discuss(?:ing)?|conversaci[oó]n|charla(?:n|ndo)?|convers(?:an|ando)?|habla(?:n|ndo)?|encuentro|moment|momento)\b/i;
 const verifiedPair=/\b(?:Uva(?: Reyes)?\s+(?:and|y|with|con)\s+Lim[oó]n(?: Duarte)?|Lim[oó]n(?: Duarte)?\s+(?:and|y|with|con)\s+Uva(?: Reyes)?)\b|\b(?:Uva(?: Reyes)?\s+(?:conversa|habla|charla)\s+con\s+Lim[oó]n(?: Duarte)?|Lim[oó]n(?: Duarte)?\s+(?:conversa|habla|charla)\s+con\s+Uva(?: Reyes)?)\b/i;
 const candidates=[];
 for(const part of parts){
  const absent=(name)=>{const p=part.toLocaleLowerCase("es"),n=name.toLocaleLowerCase("es");return p.includes("sin "+n)||p.includes("without "+n)||p.includes(n+" no está")||p.includes(n+" is absent")||p.includes(n+" no aparece");};
  const involved=names(part).filter(n=>n!==actor&&!absent(n));
  if(involved.length>=2&&verifiedPair.test(part)&&(talking.test(part)||romance.test(part))){
   candidates.push({pair:involved.slice(0,2),romantic:romance.test(part),text:part,score:(romance.test(part)?8:0)+(talking.test(part)?4:0)});
  }
 }
 candidates.sort((a,b)=>b.score-a.score);
 return candidates[0]||null;
}
function interruptionArrival(story){
 const parts=String(story).split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])|;\s*/).filter(Boolean);
 const interruption=/\b(?:irrumpe|interrumpe|interrumpe a|interrupts?|interrupt(?:ed|ing)?|walks? in|enters?|steps? in|arrives?|appears?|finds? (?:them|both)|catches? (?:them|the two)|sorprende|aparece|se presenta|entra|descubre a|encuentra a)\b/i;
 for(const part of parts){
  const match=part.match(interruption);if(!match)continue;
  const prior=names(part.slice(0,match.index));
  const cast=names(part);
  const actor=prior.length?prior[prior.length-1]:cast[0];
  if(!actor)continue;
  const scene=sceneConversation(story,actor);
  if(!scene)continue;
  return {rule:{key:"interrupcion_con_contexto",hook:scene.romantic?"ROMANCE INTERRUMPIDO":"ENCUENTRO INTERRUMPIDO"},
   priority:-1,line:part,actor,target:scene.pair[0],pair:scene.pair,romantic:scene.romantic,interrupted:/\b(?:interrumpe|irrumpe|interrupt(?:s|ed)?|walks? in|steps? in|entra|enters?)\b/i.test(part)&&!/\b(?:no|nunca|never|not)\s+interrumpe\b/i.test(part)};
 }
 return null;
}
function episodeEvent(story){
 const contextual=interruptionArrival(story);
 if(contextual)return contextual;
 const clauses=story.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])|;\s*/).filter(Boolean);
 const scored=[];
 for(const line of clauses){
  const people=names(line);
  if(!people.length)continue;
  for(let priority=0;priority<RULES.length;priority++){
   const rule=RULES[priority],hit=line.match(rule.re);
   if(!hit)continue;
   const pre=names(line.slice(0,hit.index)),post=names(line.slice(hit.index+hit[0].length));
   const actor=rule.key==="embarazo"&&/le cuenta|tells?|informs?|le anuncia/i.test(line)?people[0]:(pre.length?pre[pre.length-1]:people[0]);
   const target=post.find(x=>x!==actor)||people.find(x=>x!==actor)||"";
   scored.push({rule,priority,line,actor,target});
  }
 }
 scored.sort((x,y)=>x.priority-y.priority);
 return scored[0]||null;
}
function narrative(ev,story){
 const rule=ev.rule,a=ev.actor,b=ev.target;
 if(rule.key==="interrupcion_con_contexto"){
  const [first,second]=ev.pair.includes("Uva")&&ev.pair.includes("Limón")?["Uva","Limón"]:ev.pair;
  const hook=ev.interrupted?(ev.romantic?"ROMANCE INTERRUMPIDO":"ENCUENTRO INTERRUMPIDO"):"ENCUENTRO INESPERADO";
  const core=a+(ev.interrupted?" interrumpe a ":" encuentra a ")+first+" y "+second;
  const type=ev.romantic?"una conversación romántica":"una conversación";
  const description=(ev.interrupted?a+" irrumpe en medio de "+type+" entre "+first+" y "+second+".":a+" encuentra a "+first+" y "+second+" durante "+type+".")+
   (ev.interrupted?" La llegada de "+a+" interrumpe ese momento.":"")+
   (ev.interrupted?"\n\n¿Cómo reaccionarán "+first+" y "+second+" ante la llegada de "+a+"?":"\n\n¿Qué hará "+a+" después de encontrarlos?")+"\n\n"+TAGS;
  return {hook,core,description};
 }
 const secondary=names(story).find(n=>n!==a&&n!==b)||"";
 const other=b||secondary;
 if(!other&&!["muerte","parto"].includes(rule.key))return null;
 const nameAfter=other||"su familia";
 let hook=rule.hook,core="",desc="",question="";
 if(rule.key==="muerte"){
  core=a+" muere y deja a la familia de luto";
  desc="La muerte de "+a+" golpea a quienes lo rodean. "+(b&&/acompa[ñn]ad|accompani/i.test(story)?b+" lo acompaña en sus últimos momentos, mientras la familia enfrenta una despedida dolorosa.":"La familia queda obligada a afrontar una despedida que cambia sus vidas.");
  question="¿Cómo podrán continuar después de esta pérdida?";
 }else if(rule.key==="parto"){
  core=a+" da a luz y cambia el destino de su familia";
  desc=a+" da a luz y la llegada del bebé transforma la situación familiar. El nacimiento abre preguntas que ya no pueden evitarse.";
  question="¿Qué ocurrirá cuando todos afronten esta nueva realidad?";
 }else{
  core=a+" "+rule.verb+(["veneno","beso","humilla","enfrenta","amenaza","acusa","expulsa"].includes(rule.key)?" a ":" ")+nameAfter;
  desc=a+" "+rule.intro+" "+(["beso","veneno","revela","prueba"].includes(rule.key)?"a ":"")+nameAfter+".";
  if(rule.key==="humilla")desc=a+" humilla a "+nameAfter+".";
  if(rule.key==="enfrenta")desc=a+" encara a "+nameAfter+". La discusión deja al descubierto un conflicto que ya no pueden evitar.";
  if(rule.key==="beso")desc=a+" besa a "+nameAfter+". Ese acercamiento marca un giro en su relación.";
  if(rule.key==="enfrenta"&&secondary&&new RegExp("(?:about\\s+(?:(?:her|his|their)\\s+)?(?:relationship|connection)\\s+with|por\\s+(?:(?:su|el|la)\\s+)?(?:v[ií]nculo|relaci[oó]n)\\s+con|(?:because\\s+of|over)\\s+(?:(?:her|his|their)\\s+)?(?:relationship|connection)\\s+with)\\s+"+secondary,"i").test(story)){
   hook="CELOS EXPUESTOS";core=a+" enfrenta a "+nameAfter+" por "+secondary;
   desc=a+" encara a "+nameAfter+" por su vínculo con "+secondary+".";
  }
  if(rule.key==="enfrenta"&&/\b(no (?:va a )?competir|se niega a competir|refuses? to compete|won.t compete)\b/i.test(story)&&b){
   desc+=" "+b+" se niega a competir por ese vínculo.";
  }else if(rule.key==="revela"&&/\b(embarazo|pregnan|beb[eé]|hijo)\b/i.test(story)){
   core=a+" confiesa un secreto sobre el bebé a "+nameAfter;
   desc=a+" decide revelar a "+nameAfter+" una verdad relacionada con el bebé.";
  }else if(rule.key==="embarazo"&&/le hace creer|makes? .{0,55}believe|false father|no es el padre/i.test(story)){
   hook="MENTIRA PATERNAL";core=a+" engaña a "+nameAfter+" sobre la paternidad del bebé";
   desc=a+" le anuncia a "+nameAfter+" que espera un bebé, pero le hace creer que él es el padre. La mentira amenaza con desatar un conflicto cuando salga a la luz.";
  }else if(rule.key==="veneno"){
   desc+=" La traición pone en riesgo el futuro de la familia.";
  }else if(rule.key==="beso"){
   const witness=names(story).find(n=>n!==a&&n!==nameAfter);
   if(witness&&/ve el beso|sees? the kiss|watches? them kiss|observa el beso|presencia el beso/i.test(story))desc+=" "+witness+" presencia el beso, lo que desata una nueva tensión.";
   else desc+=" Ese acercamiento amenaza con desatar un nuevo conflicto.";
  }else if(rule.key==="engaño"){
   desc+=" La mentira sostiene una verdad que tarde o temprano puede salir a la luz.";
  }else if(rule.key==="humilla"){
   const witness=names(story).find(n=>n!==a&&n!==nameAfter);
   if(witness&&/delante de|frente a|in front of/i.test(story))desc+=" La agresión ocurre delante de "+witness+".";
  }else if(rule.key==="amenaza"){
   desc+=" Sus palabras convierten la discusión en un ultimátum.";
  }else if(rule.key==="interrumpe"){
   desc+=" Su llegada inesperada cambia el rumbo del encuentro.";
  }else if(rule.key==="escucha"||rule.key==="descubre"){
   desc+=" Lo que acaba de saber amenaza con alterar sus relaciones.";
  }else if(rule.key==="promesa"){
   desc+=" La confianza entre ambos queda puesta a prueba.";
  }else if(rule.key==="embarazo"){
   desc+=" La noticia obliga a replantear sus próximos pasos.";
  }else if(rule.key==="rechaza"){
   desc+=" La negativa marca una distancia que ya no pueden ignorar.";
  }else if(rule.key==="observar"){
   desc+=" Su presencia puede cambiar lo que los demás creen saber.";
  }else{
   desc+=" El encuentro abre un conflicto que todavía no está resuelto.";
  }
  const questions={
   veneno:"¿Quién enfrentará las consecuencias de este ataque?",
   beso:"¿Quién descubrirá lo que ocurrió entre ellos?",
   humilla:"¿Cómo responderá "+nameAfter+" a esta humillación?",
   enfrenta:"¿Qué hará "+nameAfter+" después de este enfrentamiento?",
   amenaza:"¿Cómo reaccionará "+nameAfter+" ante la advertencia?",
   revela:"¿Qué pasará cuando la verdad se conozca?",
   descubre:"¿Qué hará "+a+" con lo que acaba de descubrir?",
   rechaza:"¿Aceptará "+nameAfter+" esta decisión?",
   promesa:"¿Podrá "+a+" cumplir lo que acaba de prometer?",
   interrumpe:"¿Cómo reaccionarán los demás tras esta interrupción?",
   engaño:"¿Cuánto tiempo podrá sostenerse esta mentira?",
   escucha:"¿Qué hará "+a+" con la conversación que oyó?",
   acusa:"¿Cómo responderá "+nameAfter+" a la acusación?",
   expulsa:"¿Qué consecuencias tendrá esta expulsión?",
   embarazo:"¿Cómo cambiarán las relaciones después de la noticia?",
   prueba:"¿Quién tendrá que responder ante esta evidencia?",
   observar:"¿Qué hará "+a+" después de lo que vio?",
   hablar:"¿Qué consecuencias tendrán estas palabras?"
  };
  question=questions[rule.key]||"¿Cómo continuará esta historia?";
  if(rule.key==="beso"){
   const witness=names(story).find(n=>n!==a&&n!==nameAfter);
   if(witness&&/ve el beso|sees? the kiss|watches? them kiss|observa el beso|presencia el beso/i.test(story))question="¿Cómo reaccionará "+witness+" después de presenciar el beso?";
  }
 }
 return {hook,core,description:desc+"\n\n"+question+"\n\n"+TAGS};
}
// Fail closed for unconfirmed, negated, attempted, or merely alleged events.
// A plausible telenovela title is NOT acceptable if it changes who did what.
function riskyEvent(ev){
 const line=clean(ev.line);
 const key=ev.rule.key;
 if(key==="interrupcion_con_contexto"){
  if(/\b(?:no|nunca|never|not)\s+(?:interrumpe|interrupts?)\b/i.test(line))return "El episodio niega la interrupción.";
  return null;
 }
 const hit=line.match(ev.rule.re);
 if(!hit)return "No hay evidencia literal del acontecimiento seleccionado.";
 const before=line.slice(Math.max(0,hit.index-95),hit.index);
 const allegation=/(?:acusa(?:ba)?(?:\s+a\s+\w+){0,4}\s+de|sospecha(?:\s+que)?|cree\s+que|teme\s+que|rumores?\s+(?:de|sobre)|niega(?:\s+haber)?|denies?|suspects?|accuses?|rumou?rs?|no\s+ha|never|jam[aá]s)\s*(?:.{0,45})$/i;
 if(["veneno","muerte","parto","beso","embarazo"].includes(key)&&allegation.test(before))return "El prompt menciona una acusación, sospecha o negación; no confirma ese hecho.";
 if(["veneno","muerte","parto","beso"].includes(key)&&/(?:no|nunca|jam[aá]s|never|not|almost|casi|iba a|going to)\s*$/.test(before))return "La narración niega o no consuma el acontecimiento.";
 if(key==="beso"&&/(?:intenta\s+besar|tries?\s+to\s+kiss|attempts?\s+to\s+kiss|amenaza\s+con\s+besar)/i.test(line))return "El prompt habla de un intento o amenaza, no de un beso consumado.";
 return null;
}

function makeTitle(hook,core){
 const capital=clean(hook).toLocaleUpperCase("es");
 if(!/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(capital))return null;
 const candidate=capital+": "+clean(core).replace(/[.!?]+$/,"");
 return [candidate+" "+TAGS,candidate+" #Shorts #FruttiDrama",candidate].find(x=>x.length<=100)||null;
}

// An explicitly identified CURRENT EPISODE story is the strongest possible
// evidence: retain the original subjects, verbs, objects, negations and tense.
// Do not run the plot through keyword-to-plot templates (which fabricate events).
function extractExplicitEpisodeStory(fullPrompt){
 const src=String(fullPrompt||"").replace(/\r/g,"");
 // Original 2026 automation's Google Flow layout:
 // EPISODE on its own line, immediately followed by HOOK: story.
 // These two data items existed BEFORE the Flow generation and are authoritative.
 const originalBlock=src.match(/(?:^|\n)\s*(?:EPISODE|EPISODIO)\s*\n\s*([A-ZÁÉÍÓÚÜÑ0-9]+(?:\s+(?:[A-ZÁÉÍÓÚÜÑ0-9]+|A|DE|DEL|LA|EL)){0,4}):\s*([^\n]{20,900})/i);
 if(originalBlock){
  const legacyStory=clean(originalBlock[2]);
  if(!TECH.test(legacyStory)||ACT.test(legacyStory))
   return {hook:clean(originalBlock[1]),story:legacyStory,evidence:clean(originalBlock[1]+": "+legacyStory),legacy_structured:true};
 }

 // Include recognized Flow production headers and operator-supplied EPISODE INTENT.
 const markers=[
  /(?:^|\n)\s*(?:TRAMA CENTRAL DE ESTE EPISODIO|TRAMA PRINCIPAL DEL EPISODIO|NARRATIVA CENTRAL DEL EPISODIO|EPISODE INTENT|EPISODIO ACTUAL)\s*:\s*([^\n]*)/gi
 ];
 for(const marker of markers){
  for(const match of src.matchAll(marker)){
   const line=clean(match[1]||"")||clean(src.slice(match.index+match[0].length).split("\n").find(x=>x.trim())||"");
   if(line.length<20||line.length>900)continue;
   const named=line.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+):\s*(.{20,})$/);
   const rawHook=line.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+(?:\s+(?:[A-ZÁÉÍÓÚÜÑ0-9]+|DE|DEL|LA|EL)){0,4}):\s*(.{20,})$/);
   const hook=rawHook?rawHook[1]:"";
   const story=rawHook?rawHook[2]:line;
   if(TECH.test(story)&&!ACT.test(story))continue;
   // For unlabeled lines we cannot fabricate a hook: use the safer
   // existing scene-extraction logic, which also supports dialogue.
   if(!hook)continue;
   return {hook,story:clean(story),evidence:clean(line)};
  }
 }
 return null;
}
function explicitEpisodeCopy(explicit){
 const story=explicit.story.replace(/\s+/g," ").trim().replace(/[.!?]+\s*$/,"");
 const rawHook=clean(explicit.hook).toLocaleUpperCase("es");
 // Titles have exactly two uppercase hook words, irrespective of older prompt
 // variants that used one or three. Derived hooks cannot change the plot claim.
 const legacyHooks={"CONFESIÓN A MEDIAS":"CONFESIÓN PARCIAL","MUERTE DE BANANA":"MUERTE DEVASTADORA","FRESIA LO DEJA":"RUPTURA DEFINITIVA","NUEVO GIRO":"NUEVO GIRO"};
 const normalizedHook=legacyHooks[rawHook]||rawHook;
 const hook=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(normalizedHook)?normalizedHook:
   /\bordena\b/i.test(story)?"ORDEN DIRECTA":
   /\bpromete\b/i.test(story)?"PROMESA DECISIVA":
   /\b(?:sigue|persigue)\b/i.test(story)?"SEGUIMIENTO VEHICULAR":"";
 if(!hook)return {error:"HOOK_NOT_GROUNDED",detail:"El encabezado del episodio no tiene dos palabras y no se pudo derivar otro sin alterar la trama.",source_story:explicit.story};
 const candidates=[story];
 // Never cut at "y [proper name]": it would turn "Uva y Limón" into only Uva.
 const cuts=story.split(/\s*;\s*|\s+\bpero\b\s+/i).map(x=>x.trim()).filter(Boolean);
 candidates.push(...cuts);
 const participants=names(story);
 // Only verified semantic contractions. Never omit the second member of
 // a paired conversation; never turn an accusation/suspicion into a fact.
 if(participants.length>=2&&/\b(?:kisses|kissed|besa|besan)\b/i.test(story)&&!/\b(?:tries?\s+to|attempts?\s+to|intenta(?:n)?)\s+(?:kiss|besar)\b/i.test(story))
  candidates.splice(1,0,participants[0]+" besa a "+participants[1]);
 if(participants.length>=3&&/\binterrumpe\b/i.test(story)&&/\bconversaci[oó]n\s+entre\b/i.test(story))
  candidates.splice(1,0,participants[0]+" interrumpe a "+participants[1]+" y "+participants[2]);
 if(participants.length>=3&&/\bconfronts?\b/i.test(story)&&/\babout\s+(?:her|his|their)\s+relationship\s+with\b/i.test(story))
  candidates.splice(1,0,participants[0]+" enfrenta a "+participants[1]+" por su relación con "+participants[2]);
 const subjectForReveal=story.match(/^((?:El|La|Don)\s+[^ .,;]+|[A-ZÁÉÍÓÚÑ][^ .,;]+)\b/i);
 const laterReveal=story.match(/\s+y\s+(revela|confiesa|descubre|encuentra|advierte|anuncia|demuestra|declara)\s+(.+)$/i);
 if(subjectForReveal&&laterReveal)
  candidates.splice(1,0,subjectForReveal[1]+" "+laterReveal[1]+" "+laterReveal[2]);
 let title=null,coveredStory="";
 for(const v of candidates){
  const t=makeTitle(hook,v);
  if(t){title=t;coveredStory=v;break}
 }
 if(!title)return {error:"TITLE_LENGTH_INVALID",detail:"La trama identificada es demasiado larga para un título factual completo de YouTube. No se recortó ni reformuló su significado.",source_story:explicit.story};
 const involved=names(story);
 const question=/(?:interrumpe|irrumpe|interrupts?)/i.test(story)&&involved.length>=3?
   "¿Cómo reaccionarán "+involved.slice(1,3).join(" y ")+" ante la interrupción?":
   /acusa|accuses?/i.test(story)&&involved.length>=2?"¿Cómo responderá "+involved[1]+" a esta acusación?":
   /intenta(?:n)?\s+besar|tries?\s+to\s+kiss/i.test(story)?"¿Qué sucederá después de este intento?":
   /roba|steals?/i.test(story)?"¿Qué consecuencias tendrá este robo?":
   /encuentra|encuentran|discovers?/i.test(story)?"¿Qué ocurrirá después de este hallazgo?":
   "¿Qué pasará ahora?";
 let description=explicit.story.replace(/\s+/g," ").trim().replace(/[.!?]+\s*$/,".")+
  "\n\n"+question+"\n\n"+TAGS;
 // Exact English Flow narration can have a witnessed kiss. Preserve the actual
 // subject/object/witness while writing a natural Spanish editorial description.
 if(involved.length>=3&&/\bkisses?\b/i.test(story)&&/\bsees?\s+the\s+kiss\s+from\s+a\s+distance\b/i.test(story)&&/\bin\s+the\s+hacienda\s+garden\b/i.test(story)){
  description=involved[0]+" besa a "+involved[1]+" en el jardín de la hacienda. "+
   involved[2]+" presencia el beso a la distancia.\n\n¿Cómo reaccionará "+involved[2]+" al verlos?\n\n"+TAGS;
 }
 return {title,description,episode_excerpt:explicit.evidence.slice(0,500),
  source_story:explicit.story,method:"explicit_current_episode_extractive",
  grounding:"literal_episode_source_operator_review_required",
  warning:"Título y descripción extractivos basados en la TRAMA CENTRAL explícita, sin alterar actores ni acciones. Revisá el video antes de guardar.",
  title_excerpt:coveredStory};
}

// The operator's optional exact narrative is stronger than speculative token
// ranking. Preserve it verbatim and derive only a two-word, non-contradictory hook.
function operatorStoryCopy(fullPrompt){
 const match=String(fullPrompt||"").match(/^OPERATOR_VERIFIED_STORY:\s*([\s\S]+)$/i);
 if(!match)return null;
 const raw=clean(match[1]).slice(0,900);
 if(raw.length<22)return {error:"PLOT_SUMMARY_INVALID",detail:"La narrativa proporcionada es demasiado corta."};
 const withHook=raw.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+):\s*(.{20,})$/);
 const story=withHook?withHook[2]:raw;
 const context=/\b(?:rom[aá]ntic(?:[oa]s?|amente)|romantic(?:ally)?|amoroso|amorosa)\b/i.test(story);
 const negated=/\b(?:no|nunca|jam[aá]s|never|not)\s+(?:(?:se|lo|la|le)\s+)?(?:interrumpe|besa|envenena|mata|kiss(?:es)?|interrupts?|poisons?)\b/i.test(story);
 const alleged=/\b(?:acusa|sospecha|cree|rumor|denuncia|accuses?|suspects?)\b/i.test(story);
 const patterns=[
  [/intenta(?:n)?\s+besar|tries?\s+to\s+kiss/i,"BESO INTENTADO"],
  [/acusa|accuses?/i,"ACUSACIÓN DIRECTA"],
  [/niega|denies?/i,"NEGACIÓN DIRECTA"],
  [/interrumpe|irrumpe|interrupts?/i,context?"ROMANCE INTERRUMPIDO":"ENCUENTRO INTERRUMPIDO"],
  [/envenena|poisons?/i,"ENVENENAMIENTO CONSUMADO"],
  [/roba|steals?/i,"ROBO CONSUMADO"],
  [/muere|fallece|dies?/i,"MUERTE DEVASTADORA"],
  [/\bbesa\b|\bbesan\b|kisses?/i,"BESO REVELADOR"],
  [/embarazad[oa]|pregnan/i,"EMBARAZO REVELADO"],
  [/confronta|enfrenta|encara|confronts?/i,"ENFRENTAMIENTO DIRECTO"],
  [/promete|promises?/i,"PROMESA DECISIVA"],
  [/ordena|orders?/i,"ORDEN DIRECTA"],
  [/amenaza|threatens?/i,"AMENAZA DIRECTA"],
  [/confiesa|admite|confesses?|admits?/i,"CONFESIÓN REVELADORA"],
  [/revela|demuestra|reveals?|proves?/i,"REVELACIÓN BOMBA"],
  [/se niega|rechaza|refuses?|rejects?/i,"RECHAZO DIRECTO"],
  [/encuentra|encuentran|descubre|descubren|finds?|discovers?/i,"HALLAZGO IMPORTANTE"],
  [/exige|demands?/i,"EXIGENCIA DIRECTA"],
  [/escucha|overhears?/i,"CONVERSACIÓN ESCUCHADA"],
  [/sospecha|desconfía|suspects?/i,"SOSPECHA CRECIENTE"],
  [/buscan?|searches?/i,"BÚSQUEDA INICIADA"],
  [/ofrece|offers?/i,"PROPUESTA DIRECTA"],
  [/sigue|follows?/i,"SEGUIMIENTO DIRECTO"],
  [/se esconden|se esconde|hide|hides/i,"REFUGIO ESCONDIDO"],
  [/prepara|prepares?/i,"PREPARATIVOS ACTIVOS"],
  [/llama|calls?/i,"LLAMADA DIRECTA"],
  [/recuerda|reminds?/i,"RECUERDO DECISIVO"],
  [/observa|watches?|ve a|sees?/i,"ESCENA OBSERVADA"],
  [/hablan|conversan|talk(?:ing)?|conversation|conversaci[oó]n/i,context?"CONVERSACIÓN ROMÁNTICA":"CONVERSACIÓN DIRECTA"]
 ];
 let hook=negated?"HECHO NEGADO":withHook?.[1]||(/\bprueba m[eé]dica\b/i.test(story)&&/envenenamiento|envenenad/i.test(story)?"PRUEBA TÓXICA":null)||patterns.find(([re])=>re.test(story))?.[1]||"TRAMA CENTRAL";
 // The title body and description are an EXTRACTIVE copy of the operator's
 // words. No one can be changed from spectator to perpetrator, or from a
 // suspected action to a confirmed outcome, by this branch.
 const safe=literalCurrentCopy({hook,story,evidence:raw});
 if(!safe.error)return {...safe,method:"operator_story_literal_v27",
  warning:"La narrativa provista por la operadora se conserva completa; título estrictamente extractivo. Contrastá con el video."};
 return safe; // No heuristic rewrite of the operator's factual statement.
 // v25 fallback intentionally disabled to avoid changing who did what.
 const result=explicitEpisodeCopy({hook,story,evidence:raw});
 if(result.error)return result;
 return {...result,method:"operator_verified_story_extractive",grounding:"literal_operator_story_requires_video_review",
 warning:"Se usó textualmente TU narrativa, sin reescribir quién hace qué. El gancho de dos palabras es una clasificación editorial, no una verificación del video."};
}

// A real Flow prompt can put ALL story beats inside prose paragraphs interleaved
// with @character reference directions, rather than a labeled episode section.
// Ground this precise three-role scene in visible actions and speech. Never
// infer that Fresia interrupts Uva alone: Limón is the other interlocutor.
function warmConversationInterruptedByFresia(fullPrompt){
 const script=String(fullPrompt||"").replace(/\r/g,"");
 const scene=script.split(/\n\s*(?:C[aá]mara|Camera|Estilo|Style|Iluminaci[oó]n|Lighting|Audio|Idioma|Language|Constraints|Anti.Glitch)\s*:/i)[0];
 const trio=/\bFresia\b/i.test(scene)&&/\bUva(?: Reyes)?\b/i.test(scene)&&/\bLim[oó]n(?: Duarte)?\b/i.test(scene);
 const together=/\b(?:the two talking|talking warmly|share a conversation|talk(?:ing)? together|conversan juntos|conversaci[oó]n entre Uva y Lim[oó]n|los dos conversan)\b/i.test(scene);
 const near=/\b(?:sits close beside Uva|sits beside him|sits close to Uva|comparten el banco|sentados juntos|sitting close)\b/i.test(scene);
 const arrival=/(?:\bFresia\b[\s\S]{0,230}\b(?:walks into frame|walks in|enters|irrumpe|interrumpe|aparece|entra)\b)/i.test(scene);
 const insult=/(?:criada tan atrevida|ni las sobras se te escapan)/i.test(scene);
 const speech=/(?:Fresia is the ONLY one who speaks|only Fresia speaks|Fresia dice|Fresia le dice|Fresia speaks)/i.test(scene);
 if(!trio||!together||!near||!arrival||!insult||!speech)return null;
 if(/\b(?:never|not|no|nunca)\s+(?:walks into frame|walks in|enters|interrumpe|habla)\b/i.test(scene))return null;
 const affectionate=/talking warmly|softly laughing together|romantic|conversaci[oó]n rom[aá]ntica|cariñosamente/i.test(scene);
 const hook=affectionate?"ROMANCE INTERRUMPIDO":"ENCUENTRO INTERRUMPIDO";
 const title=makeTitle(hook,"Fresia interrumpe a Uva y Limón en el jardín");
 const description=
  "Uva y Limón conversan juntos en el jardín de la hacienda cuando Fresia entra y los encuentra. "+
  "Fresia insulta a Uva con las palabras «criada tan atrevida» y «ni las sobras se te escapan». "+
  "Después se retira, mientras Uva y Limón permanecen en silencio."+
  "\n\n¿Cómo reaccionarán Uva y Limón ante la humillación?\n\n"+TAGS;
 return {title,description,episode_excerpt:"Uva y Limón conversan juntos; Fresia entra, insulta a Uva y se retira.",
  source_story:"Fresia aparece mientras Uva y Limón conversan juntos. Fresia insulta a Uva y luego se marcha. Ninguno de los otros dos habla.",
  method:"grounded_prose_scene_actions_and_dialogue",
  grounding:"explicit_scene_actions_speech_and_character_roles_operator_review_required",
  warning:"Borrador basado en acciones y diálogos presentes en el prompt, no en el canon histórico. Revisá el video antes de guardar."};
}

// Recover the narrative from free-form Google Flow prose when a separate
// structured hook/story is unavailable. Source evidence stays visible.
function proseSceneCopy(prompt){
 const raw=String(prompt||"").replace(/\r/g,"");
 const lines=raw.split("\n");
 const actions=[
  [/intenta\s+besar|tries?\s+to\s+kiss/i,"BESO INTENTADO","intenta besar",100],
  [/roba|steals?|stole/i,"ROBO REVELADO","roba",96],
  [/confiesa|confesses?|admits?|admite/i,"CONFESIÓN IMPACTANTE","confiesa",94],
  [/acusa|accuses?/i,"ACUSACIÓN DIRECTA","acusa",93],
  [/revela|reveals?|anuncia|announces?/i,"REVELACIÓN IMPORTANTE","revela",91],
  [/descubre|discovers?|finds? out/i,"HALLAZGO DECISIVO","descubre",89],
  [/insulta|humilla|insults?|humiliates?/i,"HUMILLACIÓN CRUEL","humilla",88],
  [/enfrenta|confronts?|encara/i,"ENFRENTAMIENTO DIRECTO","enfrenta",87],
  [/\bbesa\b|\bbesan\b|kisses?/i,"BESO REVELADOR","besa",85],
  [/reads?|reading|lee/i,"DOCUMENTO REVELADOR","lee",78],
  [/examina|examines?|studies?|reviews?/i,"DOCUMENTO REVELADOR","examina",77],
  [/entrega|hands? over/i,"PRUEBA ENTREGADA","entrega",76],
  [/muestra|shows?/i,"PRUEBA MOSTRADA","muestra",75],
  [/encuentra|encuentran|finds?|found/i,"HALLAZGO INESPERADO","encuentra",72],
  [/ordena|orders?|exige|demands?/i,"ORDEN TERMINANTE","ordena",70],
  [/recibe|receives?/i,"NOTICIA INESPERADA","recibe",66],
  [/esconde|oculta|hides?|conceals?/i,"SECRETO OCULTO","esconde",63],
  [/llora|cries?|sobs?/i,"DOLOR PROFUNDO","llora",58],
  [/abre|opens?/i,"HALLAZGO ABIERTO","abre",54],
  [/holds?|sostiene/i,"OBJETO REVELADOR","sostiene",53],
  [/looks? at|stares? at|watches?|mira|observa/i,"ESCENA REVELADORA","observa",52],
  [/talks?\s+to|conversa\s+con|habla\s+con|speaks?\s+with/i,"CONVERSACIÓN IMPORTANTE","habla",65],
  [/speaks?|says?|tells?|whispers?|shouts?|dice|responde|grita/i,"PALABRAS DECISIVAS","habla",48],
  [/enters?|walks? into|walks? in|entra|aparece|arrives?/i,"LLEGADA INESPERADA","aparece",35]
 ];
 const objects=[
  [/medical report|clinical report|medical file|lab results?|medical records?|informe m[eé]dico|informe cl[ií]nico|an[aá]lisis cl[ií]nicos?/i,"un informe médico"],
  [/diagnosis|diagn[oó]stico/i,"un diagnóstico"],
  [/letter|carta/i,"una carta"],[/document|documento|paperwork|papeles/i,"un documento"],
  [/photograph|photo|foto|fotograf[ií]a/i,"una fotografía"],[/envelope|sobre/i,"un sobre"],
  [/message|mensaje|note\b|nota\b/i,"una nota"],[/report|informe/i,"un informe"],
  [/box|caja/i,"una caja"],[/key\b|llave/i,"una llave"],[/phone|call\b|llamada/i,"una llamada"]
 ];
 const candidates=[];let section="scene",i=0;
 for(let line of lines){
  line=clean(line);if(!line)continue;i++;
  if(/^(?:CANON|CONTINUITY|CREATIVE BIBLE|SHOW BIBLE|PREVIOUS EPISODE|BACKSTORY|ANTECEDENTES|AUTORIDAD VISUAL Y CANON)\s*:?\s*$/i.test(line)){section="canon";continue}
  if(/^(?:C[AÁ]MARA|CAMERA|LIGHTING|ILUMINACI[OÓ]N|ESTILO|STYLE|RENDER|AUDIO|SOUND|CONSTRAINTS|ANTI.GLITCH|IDIOMA|LANGUAGE|NEGATIVE|ASSETS?|REFERENCE|GENERATION)\s*:/i.test(line)){section="technical";continue}
  if(/^(?:SCENE|ESCENA|BEAT|SEQUENCE|SECUENCIA|TRAMA|STORY|EPISODE|EPISODIO|ACTION|ACCI[OÓ]N)(?:\s*\d+)?\s*[:：-]?\s*(.*)$/i.test(line)){
   section="scene";line=line.replace(/^(?:SCENE|ESCENA|BEAT|SEQUENCE|SECUENCIA|TRAMA|STORY|EPISODE|EPISODIO|ACTION|ACCI[OÓ]N)(?:\s*\d+)?\s*[:：-]?\s*/i,"");
  }
  if(section!=="scene")continue;
  const chunks=line.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ"“@¿])|;\s*/).map(clean).filter(Boolean);
  for(const chunk of chunks){
   const people=names(chunk);if(!people.length)continue;
   if(/^(?:generate|render|create exactly|no duplicates|no subtitles)/i.test(chunk))continue;
   for(const [re,hook,verb,rank] of actions){
    const hit=chunk.match(re);if(!hit)continue;
    const before=chunk.slice(0,hit.index),after=chunk.slice(hit.index+hit[0].length);
    if(/\b(?:no|nunca|not|never|almost|casi)\s*$/i.test(before))continue;
    if(/\b(?:attempts?|tries?|intenta)\s+(?:to\s+)?$/i.test(before)&&hook!=="BESO INTENTADO")continue;
    const pre=names(before);
    const actor=pre[0]||people[0];
    if(!actor)continue;
    const target=names(after).find(n=>n!==actor)||"";
    const obj=objects.find(([re])=>re.test(after))?.[1]||"";
    if(["lee","examina","muestra","entrega","recibe","roba","esconde","abre","sostiene"].includes(verb)&&!obj)continue;
    const quote=chunk.match(/[«“"]([^»”"]{10,200})[»”"]/);
    const score=rank+(pre.length?12:0)+(target?5:0)+(obj?4:0)-(chunk.startsWith("Use the attached")?9:0);
    candidates.push({chunk,actor,target,obj,hook,verb,score,order:i,quote:quote?.[1]||""});
    break;
   }
  }
 }
 if(!candidates.length)return null;
 candidates.sort((a,b)=>b.score-a.score||a.order-b.order);
 const best=candidates[0];if(best.score<55)return null;
 const verb=best.verb;
 const objectFirst=["lee","examina","muestra","entrega","recibe","roba","esconde","abre","sostiene","encuentra","observa"].includes(verb);
 const withTarget=best.target?((verb==="habla"?" con ":" a ")+best.target):"";
 const event=best.actor+" "+verb+(objectFirst&&best.obj?" "+best.obj:best.target?withTarget:best.obj?" "+best.obj:"")+(verb==="observa"&&/from the window|desde la ventana/i.test(best.chunk)?" desde la ventana":"");
 const title=makeTitle(best.hook,event);if(!title)return null;
 const evidence=[...new Set(candidates.sort((a,b)=>a.order-b.order).filter(v=>v.score>=55).slice(0,5).map(v=>v.chunk))].join(" ").slice(0,1800);
 const quote=best.quote?" En el episodio se escucha: «"+best.quote.replace(/[«»“”"]/g,"").trim()+"».":"";
 const fromWindow=/from the window|desde la ventana/i.test(best.chunk)?" desde la ventana":"";
 const evidenceDetails=[];
 const witness=candidates.find(v=>v.actor!==best.actor&&v.verb==="observa"&&/from the window|desde la ventana/i.test(v.chunk));
 if(witness)evidenceDetails.push(witness.actor+" observa desde la ventana.");
 if(/(?:about|sobre)\s+Banana/i.test(evidence)&&/informe|report|reads?|lee/i.test(evidence))evidenceDetails.push("El documento menciona a Banana.");
 if(/looks? devastated|visiblemente devastad[oa]/i.test(evidence))evidenceDetails.push(best.actor+" se muestra devastado.");
 if(/hands? trembl|shaking hands?|le tiemblan las manos|manos temblorosas/i.test(evidence))evidenceDetails.push("Le tiemblan las manos.");
 if(/walks? away|se retira|se marcha/i.test(evidence))evidenceDetails.push("Después se retira.");
 const desc=event.charAt(0).toUpperCase()+event.slice(1)+"."+quote+(evidenceDetails.length?" "+[...new Set(evidenceDetails)].join(" "):"")+"\n\n¿Qué sucederá después?\n\n"+TAGS;
 return {title,description:desc,episode_excerpt:best.chunk.slice(0,500),source_story:evidence,
  method:"unstructured_scene_action_evidence",grounding:"literal_scene_actions_requires_review",
  warning:"Propuesta extraída de acciones explícitas de una escena libre. Se muestran los fragmentos fuente; verificá que el evento principal corresponda al video."};
}

// v26 — Exact current STORY/H O O K contract. Prior CANON is never the present episode.
function authoritativeCurrentStory(source) {
 const lines=String(source||"").replace(/\r/g,"").split("\n");
 let section="other",hook="",story=[],reading=false,hasEpisode=false;
 for(const raw of lines){
  const line=raw.trim().replace(/^#{1,5}\s*/,"").replace(/^[•*-]\s+/,"").trim();
  if(!line)continue;
  if(/^(?:CANON|CONTINUITY|PREVIOUS(?:\s+CANONICAL)?\s+(?:BEAT|EPISODE)|PERMANENT CANON|BACKSTORY|SHOW BIBLE|CREATIVE BIBLE)\b/i.test(line)){section="context";reading=false;continue}
  if(/^(?:STORY\s*[/&+]\s*ACTION|EPISODE|EPISODIO|CURRENT EPISODE|EPISODIO ACTUAL)\s*:?\s*$/i.test(line)){section="current";hasEpisode=true;hook="";story=[];reading=false;continue}
  if(/^(?:CAMERA|LIGHTING|AUDIO|VOICE|SOUND|OUTPUT|VISUALS?|CHARACTER|REFERENCE|CONSTRAINTS?|ANTI.GLITCH|GENERATION|BEATS\s*\/\s*TIMING|RENDER|IDIOMA|LANGUAGE|NEGATIVE)\s*(?::|\/|$)/i.test(line)){section="technical";reading=false;continue}
  if(section!=="current")continue;
  const h=line.match(/^HOOK\s*[:：]\s*(.+)$/i);
  if(h){hook=h[1].trim();reading=false;continue}
  const s=line.match(/^(?:STORY|EPISODE INTENT|TRAMA(?: DEL EPISODIO)?)\s*[:：]\s*(.*)$/i);
  if(s){story=s[1].trim()?[s[1].trim()]:[];reading=true;continue}
  if(reading&&!/^(?:SHOT|SCENE|ESCENA|BEAT)\s*\d*\s*[:：]/i.test(line))story.push(line);
 }
 if(!hasEpisode||!hook)return null;
 const plot=story.join(" ").replace(/\s+/g," ").trim();
 if(plot.length<22)return {error:"CURRENT_STORY_MISSING",detail:"El episodio actual tiene HOOK pero no STORY. No se usó CONTINUITY."};
 if(plot.length>1800)return {error:"CURRENT_STORY_TOO_LONG",detail:"La narrativa excede el límite de extracción segura."};
 return {hook,story:plot,evidence:"HOOK: "+hook+" | STORY: "+plot};
}
// Titles are literal, not invented paraphrases. Full STORY is retained in description.
function literalCurrentCopy(e){
 const story=String(e.story||"").replace(/\s+/g," ").trim(),hook=String(e.hook||"").toLocaleUpperCase("es").trim();
 if(!/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(hook))return {error:"HOOK_FORMAT_INVALID",detail:"HOOK debe tener dos palabras."};
 const first=story.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÜÑ¿])/)[0].replace(/[.!?]+$/,"");
 const words=first.split(/\s+/),pieces=[first];
 for(const pattern of [/\s*;\s*/,/,\s*(?:pero|mientras|aunque)\b/i,/\s+que\s+(?:confirma|indica|revela|demuestra|significa)\b/i]){
  const m=first.match(pattern);if(m&&m.index>=25)pieces.push(first.slice(0,m.index).trim());
 }
 for(let n=words.length-1;n>=5;n--){
  if(/^(de|del|a|al|con|para|entre|el|la|que|y|o|pero|en|sobre|sus?|un|una|no|nunca)$/i.test(words[n-1]))continue;
  const prefix=words.slice(0,n).join(" ");if(prefix.length<25)break;pieces.push(prefix);
 }
 const pair=first.match(/(?:entre|between)\s+([A-ZÁÉÍÓÚÜÑ]\p{L}+)(?:\s+\p{L}+)?\s+(?:y|and)\s+([A-ZÁÉÍÓÚÜÑ]\p{L}+)/iu);
 const verbs=/\b(?:nota|sorprende|admite|pregunta|exige|obliga|prepara|ofrece|contiene|buscan|busca|encuentran|demuestra|llama|deciden|consigue|incluye|resulta|asegura|descubren|salen|esconden|informa|recibe|lee|entrega|confirma|interrumpe|irrumpe|encuentra|enfrenta|confronta|besa|intenta|acusa|rechaza|niega|descubre|sospecha|conversa|habla|promete|muere|envenena|revela|confiesa|advierte|observa|escucha|ordena|sigue|muestra|roba|recuerda|conoce|comprende|discute|regresa|abandona|enfrentan?|interrumpen?|intentan?|reciben?|se entera|confronts?|receives?|finds?|interrupts?|kisses?|accuses?)\b/i;
 for(const p of [...new Set(pieces)]){
  if(p.length<24||!verbs.test(p))continue;
  if(pair&&(!p.includes(pair[1])||!p.includes(pair[2])))continue;
  const polar=/\b(?:no|nunca|ni|intenta|sospecha|acusa|niega|podr[ií]a|quiz[aá]s)\b/i;
  if(polar.test(first)&&!polar.test(p))continue;
  const title=makeTitle(hook,p);
  if(title)return {title,description:story.replace(/[.!?]+\s*$/,".")+"\n\n¿Qué pasará después?\n\n"+TAGS,
   source_story:story,episode_excerpt:e.evidence.slice(0,500),title_excerpt:p,
   method:"authoritative_hook_story_literal_v26",grounding:"literal_current_episode_operator_review",
   warning:"HOOK y STORY tomados del episodio actual. Título extractivo, descripción íntegra. Verificá el video antes de guardar."};
 }
 return {error:"TITLE_LENGTH_INVALID",detail:"No se encontró un fragmento literal para un título fiel de hasta 100 caracteres.",source_story:story};
}


// v28: text can arrive with CONTINUITY, STORY / ACTION, HOOK and STORY
// on the SAME line after copying from Flow. Heading boundaries are semantic
// delimiters, NEVER a newline requirement. Previous beat is always excluded.

// FruttiDrama v30: Section boundaries are parsed BEFORE story whitespace is
// collapsed. When prompts are copied as paragraphs, old render/camera sections
// must never be included in STORY or force a spurious >1800-character rejection.
function extractCollapsedCurrentStory(input) {
 const raw=String(input||"").replace(/\r\n?/g,"\n")
  .replace(/[\u2028\u2029]/g,"\n").replace(/[\u00a0\u200b]/g," ").replace(/\*\*/g,"");
 const matches=[...raw.matchAll(/\bSTORY\s*[/&+]\s*ACTION\b/gi)];
 if(!matches.length)return null;
 // The current episode is after the FINAL explicit STORY / ACTION heading.
 const marker=matches[matches.length-1];
 let section=raw.slice(marker.index+marker[0].length);
 const hookTag=section.match(/\bHOOK\s*[:：]\s*/i);
 if(!hookTag)return {error:"CURRENT_HOOK_NOT_FOUND",
  detail:"Encontré STORY / ACTION, pero falta HOOK del episodio actual. Nunca se usa Previous canonical beat."};
 const hookRest=section.slice(hookTag.index+hookTag[0].length);
 const storyTag=hookRest.match(/\bSTORY\s*[:：]\s*/i);
 if(!storyTag)return {error:"CURRENT_STORY_NOT_FOUND",
  detail:"Encontré HOOK actual pero falta STORY; nunca se utilizará CONTINUITY."};
 const rawHook=hookRest.slice(0,storyTag.index).replace(/^[\s*:#-]+|[\s*:#-]+$/g,"")
  .replace(/\s+/g," ").trim().toLocaleUpperCase("es");
 const hook=rawHook==="ORDEN DE SALIDA"?"SALIDA FORZADA":
            rawHook==="FURIA DEL PATRÓN"?"FURIA PATRONAL":rawHook;
 if(!/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(hook))
  return {error:"HOOK_FORMAT_INVALID",detail:"HOOK no tiene exactamente dos palabras: "+rawHook};
 let narrative=hookRest.slice(storyTag.index+storyTag[0].length);
 const cuts=[];
 const stop=(re)=>{for(const match of narrative.matchAll(re))if(match.index!==undefined&&match.index>0)cuts.push(match.index)};
 // Never flatten whitespace before finding the next heading. Covers full
 // uppercase Markdown section headings and ordinary named production blocks.
 stop(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:CAMERA(?:\s*\/\s*LIGHTING)?|C[AÁ]MARA|LIGHTING|ILUMINACI[OÓ]N|CINEMATOGRAPHY|CINEMATOGRAF[IÍ]A|VISUALS?|VISUAL STYLE|CHARACTER(?:S|\s+LOCK|\s+REFERENCES?|\s+SHEETS?|\s+DESIGN)?|REFERENCE(?:\s+SHEETS?|\s+IMAGES?)?|ASSET(?:\s+LOCK)?|LOCATION(?:\s+LOCK)?|AMBIENT(?:\s+AUDIO)?|AUDIO|SOUND(?:\s+DESIGN)?|MUSIC|DIALOGUE(?:\s+RULES)?|DI[AÁ]LOGO|VOICE(?:\s+ASSIGNMENT|\s+RULES)?|ACTING|BLOCKING|TIMING|TIMELINE|TIME(?:\s+MAP)?|SHOT(?:\s+LIST|\s+PLAN|\s+BREAKDOWN)?|SCENE(?:\s+BREAKDOWN|\s+PLAN)?|BEAT(?:S|\s*[/&]\s*TIMING)?|EXACT\s+10.SECOND|NARRATIVE\s+NOVELTY\s+LOCK|STRICT\s+ANTI.GLITCH|ANTI.GLITCH(?:\s*\/\s*PREFLIGHT)?|NEGATIVE(?:\s+PROMPT)?|OUTPUT(?:\s+CONSTRAINTS?)?|CONSTRAINTS?|GENERATION(?:\s+RULES)?|RENDER(?:\s+SETTINGS)?|TECHNICAL(?:\s+INSTRUCTIONS|\s+RULES)?|PRODUCTION(?:\s+NOTES|\s+RULES)?|DELIVERY(?:\s+SPECS)?|EDITING|CONTINUITY|CANON|PREVIOUS\s+CANONICAL\s+BEAT|NEXT\s+EPISODE|END(?:\s+STATE)?|RESTRICTIONS?|FINAL(?:\s+PROMPT)?|ESTRUCTURA\s+OBLIGATORIA|PREFLIGHT|REGLAS|NOTAS)(?:\s+\d+(?:\s*[-–]\s*\d+)?)?\s*(?:[:：\n]|$)/gim);
 // Canonical prompt templates commonly use independent ALL-CAPS headings with
 // no colon, and "2–6.5 s —" as shot instructions.
 stop(/\n\s*(?:#{1,6}\s*)?[A-ZÁÉÍÓÚÜÑ0-9][A-ZÁÉÍÓÚÜÑ0-9\s/&+().,:;—–-]{5,115}\s*(?::|$)/gm);
 stop(/\n\s*(?:\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:s|sec|seg)\b|\d+\s*(?:s|sec|seg)\s*[-–:]|\d+\s*[-.)]\s*(?:SCENE|SHOT|BEAT|ESCENA|PLANO))[\s\S]{0,5}/gim);
 stop(/\n\s*(?:-{3,}|={3,}|\*{3,})\s*(?:\n|$)/gm);
 // Also handle collapsed inline headings, e.g. "... STORY: ... CAMERA: ...",
 // when the prompt is copied as one long paragraph from Flow.
 stop(/\s+(?:CAMERA|C[AÁ]MARA|LIGHTING|ILUMINACI[OÓ]N|CINEMATOGRAPHY|VISUAL\s+STYLE|OUTPUT(?:\s+CONSTRAINTS?)?|RENDER|ANTI.GLITCH|NEGATIVE\s+PROMPT|SOUND\s+DESIGN|AUDIO|DIALOGUE(?:\s+RULES)?|CHARACTER\s+(?:LOCK|REFERENCES?|SHEETS?)|PRODUCTION\s+NOTES|TECHNICAL\s+INSTRUCTIONS|SHOT\s+PLAN|SCENE\s+PLAN|BEATS?\s*[/&]\s*TIMING|NARRATIVE\s+NOVELTY\s+LOCK|STRICT\s+ANTI.GLITCH|TIMELINE|EXACT\s+10.SECOND|CONSTRAINTS?)\s*[:：]/gi);


 // v34: when copied Flow text collapses into one paragraph, a technical
 // instruction can immediately follow a complete STORY sentence without a
 // recognizable heading. Only cut at sentence boundaries with corroborating
 // production language; leave every genuine dramatic sentence intact.
 const nonStoryInstruction=/^(?:the\s+(?:characters?|performances?|camera|shots?|video|visuals?|renders?|lighting|voices?|actors?)\b|(?:ensure|maintain|preserve|match|keep|use|avoid|never|do\s+not|generate|render|enforce|verify|respect|lock)\b|(?:los|las|el|la)\s+(?:personajes?|c[aá]maras?|planos?|voces?|referencias?|iluminaci[oó]n)\b|(?:mantener|preservar|asegurar|evitar|utilizar|respetar|conservar|generar|verificar|no\s+(?:agregar|duplicar|mostrar))\b)/iu;
 const technicalEvidence=/\b(?:character|characters|performance|actor|identity|asset|assets|reference|references|sheet|sheets|frame|frames|glitch|camera|lighting|render|rendering|shot|shots|duplicate|duplicates|voice|lip.?sync|video|visual|model|constraints?|continuity|fixed|locked|consistent|consistency|framing|background|foreground|output|instructions?|generation|personajes?|identidad|referencias?|encuadre|fotogramas?|iluminaci[oó]n|c[aá]mara|planos?|voces?|duplicados?|fijos?|instrucciones?|generaci[oó]n)\b/giu;
 for(const m of narrative.matchAll(/(?<=[.!?…])[ \t\n]+(?=\S)/gu)){
  const preceding=narrative.slice(0,m.index).trimEnd();
  const upcoming=narrative.slice(m.index+m[0].length).trimStart();
  const sentence=upcoming.slice(0,220).split(/(?<=[.!?…])\s+/u)[0];
  const technicalHits=[...sentence.matchAll(technicalEvidence)].length;
  const first=preceding.trimStart().slice(0,160);
  const firstLooksTechnical=nonStoryInstruction.test(first)&&TECH.test(first);
  if(preceding.length>=28&&preceding.length<=1800&&!firstLooksTechnical&&
     nonStoryInstruction.test(sentence)&&technicalHits>=2)cuts.push(m.index);
 }
 // Generic noncanonical headings and paragraph separators.
 stop(/\n\s*(?:#{1,6}\s*)?[\p{L}][\p{L}\d /&+().,-]{2,84}\s*[:：]\s*/giu);
 stop(/[ \t]+[A-ZÁÉÍÓÚÜÑ0-9]{2,}(?:[ /&+().-]+[A-ZÁÉÍÓÚÜÑ0-9]{2,}){1,8}\s*[:：]\s*/g);
 stop(/[ \t]+(?:camera|action|scene|visual|lighting|sound|production|editing|technical|motion|stage|cinematography|animation|voice|performance|environment|direction|acting)\s+[\p{L}0-9][\p{L}0-9 &/+().,-]{3,85}\s*[:：]/giu);
 stop(/\n\s*(?:[-•*]{1,3}|[—–-]{2,})\s+[\p{L}]/giu);
 stop(/[ \t]+(?:---|——|––)\s+[\p{L}]/giu);
 // A complete narrative sentence followed by another character's scene beat
 // may continue across a blank line. Do not cut genuine story continuation.
 const sceneContinuation=s=>/^(?:(?:Don\s+)?(?:Melón|Uva|Fresia|Mango|Limón|Banana|Bananita)|El\s+(?:documento|testigo|grupo)|La\s+(?:carta|prueba|hoja)|Ella|Él|Ambos|Los\s+dos)\b/iu.test(s)
  && /\b(?:recibe|comprende|descubre|encuentra|dice|acusa|interrumpe|sabe|revela|entiende|responde|confirma|escucha|llora|enfrenta|observa|sale|vuelve|promete|señala|niega|reconoce|admite|ordena|obliga|intenta|ofrece|logra|muestra|ve|habla)\b/iu.test(s);
 for(const m of narrative.matchAll(/\n[ \t]*\n/g)){
  const before=narrative.slice(0,m.index).trim();
  const next=narrative.slice(m.index+m[0].length).trimStart().split("\n")[0].trim();
  if(before.length>=25&&before.length<1500&&/[.!?…]["'»”]?$/u.test(before)&&!sceneContinuation(next))cuts.push(m.index);
 }
 let offset=cuts.length?Math.min(...cuts):narrative.length;
 if(offset>1800){
  // When all production headings are unrecognizable, extract only finished
  // sentences from the initial physical STORY lines. Never copy the plan.
  const lines=narrative.trimStart().split("\n");
  let candidate="",endAt=-1,read=0;
  for(const rawLine of lines){
   const line=rawLine.trim();
   if(!line){if(candidate&&/[.!?…]["'»”]?$/u.test(candidate))break;continue}
   if(read>=4||candidate.length+line.length>1300)break;
   if(candidate&&/[.!?…]["'»”]?$/u.test(candidate)&&!sceneContinuation(line))break;
   if(/^(?:CAMERA|CHARACTER|CONSTRAINT|AUDIO|BEAT|SHOT|SCENE|VISUAL|NARRATIVE NOVELTY|OUTPUT|PREVIOUS|USE\b|KEEP\b|MAKE\b|ONLY\b|NEVER\b|THE CAMERA\b|THE SHOT\b|TECHNICAL\b|MAINTAIN\b|PRESERVE\b|ENFORCE\b|RENDER\b|ENSURE\b|GENERATE\b|CINEMATIC\b|CINEMATOGRAPHY\b)/i.test(line))break;
   candidate+=(candidate?" ":"")+line;
   endAt=narrative.indexOf(line,Math.max(0,endAt))+line.length;
   read++;
  }
  if(candidate.length>=30&&candidate.length<=1300&&/[.!?…]["'»”]?$/u.test(candidate))
    offset=endAt;
 }
 let story=narrative.slice(0,offset).replace(/^\s*[-•*]\s*/,"").replace(/\s+/g," ").trim();
 // Be conservative: a 10-second current STORY is typically 1–3 sentences.
 // If truly >1800 without a verifiable heading, do not invent a boundary.
 if(story.length<22)return {error:"CURRENT_STORY_NOT_FOUND",
  detail:"El bloque STORY actual está vacío. No se tomó la continuidad."};
 if(story.length>1800)return {error:"CURRENT_STORY_BOUNDARY_AMBIGUOUS",
  detail:"No pude separar STORY de las instrucciones posteriores sin arriesgar la narrativa. El beat anterior queda excluido."};
 return {hook,story,evidence:"HOOK: "+hook+" | STORY: "+story,
  method:"story_action_v34",extraction_boundary:offset,engine_revision:"story_action_v34"};
}

export function generateFruttiRecapCopy(fullPrompt){
 const operator=operatorStoryCopy(fullPrompt);
 if(operator)return operator;
 const v28=extractCollapsedCurrentStory(fullPrompt);
 if(v28)return v28.error?v28:literalCurrentCopy(v28);
 const strict=authoritativeCurrentStory(fullPrompt);
 if(strict)return strict.error?strict:literalCurrentCopy(strict);
 const explicit=extractExplicitEpisodeStory(fullPrompt);
 if(explicit)return explicitEpisodeCopy(explicit);
 if(/\b(?:Previous canonical beat|Previous episode beat|CONTINUITY Previous|CONTINUIDAD Previous)\b/i.test(String(fullPrompt||"")))
  return {error:"CURRENT_EPISODE_SECTION_NOT_FOUND",detail:"Solo encontré referencia al episodio anterior; falta una sección STORY / ACTION recuperable. No se generan metadatos a partir de Previous canonical beat."};
 const richScene=warmConversationInterruptedByFresia(fullPrompt);
 if(richScene)return richScene;
 const input=extract(fullPrompt);
 if(input.error)return proseSceneCopy(fullPrompt)||input;
 const ev=episodeEvent(input.story);
 if(!ev)return proseSceneCopy(fullPrompt)||{error:"EPISODE_ACTION_UNCLEAR",detail:"No pude reconocer una acción concreta con personajes en el episodio. No inventé un título ni copié el prompt."};
 const uncertainty=riskyEvent(ev);
 if(uncertainty){
  const safe=proseSceneCopy(fullPrompt);
  if(safe&&/^(?:BESO INTENTADO|ACUSACIÓN DIRECTA|HECHO NEGADO):/.test(safe.title))return safe;
  return {error:"NARRATIVE_GROUNDING_REQUIRED",detail:uncertainty,episode_excerpt:clean(ev.line).slice(0,500)};
 }
 const copy=narrative(ev,input.story);
 if(!copy)return proseSceneCopy(fullPrompt)||{error:"EPISODE_ACTION_UNCLEAR",detail:"No pude identificar con certeza quién actúa y a quién afecta. Podés completar el título y la descripción manualmente."};
 const originalHook=clean(input.hook).toUpperCase();
 const usable=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(originalHook)&&!/(DRAMA FAMILIAR|NUEVA CRISIS|GIRO IMPACTANTE)/.test(originalHook);
 const title=makeTitle(usable&&ev.rule.key!=="interrupcion_con_contexto"?originalHook:copy.hook,copy.core)||makeTitle(copy.hook,copy.core);
 if(!title)return {error:"TITLE_LENGTH_INVALID",detail:"No hay espacio suficiente para un título completo de hasta 100 caracteres."};
 return {title,description:copy.description,episode_excerpt:clean(ev.line).slice(0,300),method:"historical_editorial_hook_story_templates",warning:"Borrador por reglas editoriales locales; NO hay un modelo de lenguaje verificando la narrativa. Contrastá cada acontecimiento con el prompt y el video antes de guardar.",grounding:"heuristic_operator_review_required",source_story:input.story.slice(0,1800)};
}
