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
 const explicitPair=/\b(?:entre|between|with|con)\b/i;
 const candidates=[];
 for(const part of parts){
  const absent=(name)=>{const p=part.toLocaleLowerCase("es"),n=name.toLocaleLowerCase("es");return p.includes("sin "+n)||p.includes("without "+n)||p.includes(n+" no está")||p.includes(n+" is absent")||p.includes(n+" no aparece");};
  const involved=names(part).filter(n=>n!==actor&&!absent(n));
  if(involved.length>=2&&(talking.test(part)||romance.test(part)||explicitPair.test(part))){
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
  if(rule.key==="humilla")desc=a+" humilla a "+nameAfter+". El ataque verbal rompe cualquier apariencia de cordialidad.";
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
   if(witness&&/delante de|frente a|in front of/i.test(story))desc+=" La agresión ocurre delante de "+witness+" y provoca un enfrentamiento abierto.";
   else desc+=" La humillación transforma la tensión entre ambos en un enfrentamiento abierto.";
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
 const hook=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(rawHook)?rawHook:
   /\bordena\b/i.test(story)?"ORDEN DIRECTA":
   /\bpromete\b/i.test(story)?"PROMESA DECISIVA":
   /\b(?:sigue|persigue)\b/i.test(story)?"SEGUIMIENTO VEHICULAR":"";
 if(!hook)return {error:"HOOK_NOT_GROUNDED",detail:"El encabezado del episodio no tiene dos palabras y no se pudo derivar otro sin alterar la trama.",source_story:explicit.story};
 const candidates=[story];
 const cuts=story.split(/\s*;\s*|\s+\bpero\b\s+|\s+\by\b\s+(?=[A-ZÁÉÍÓÚÑ])/i).map(x=>x.trim()).filter(Boolean);
 candidates.push(...cuts);
 const secondEvent=story.match(/^((?:El|La|Don)\s+[A-ZÁÉÍÓÚÑ][^\s,;]+|[A-ZÁÉÍÓÚÑ][^\s,;]+)\s+.+?\s+y\s+(revela|confiesa|descubre|encuentra|advierte|anuncia|demuestra|declara)\s+(.+)$/i);
 if(secondEvent)candidates.splice(1,0,secondEvent[1]+" "+secondEvent[2]+" "+secondEvent[3]);
 let title=null,coveredStory="";
 for(const v of candidates){
  const t=makeTitle(hook,v);
  if(t){title=t;coveredStory=v;break}
 }
 if(!title)return {error:"TITLE_LENGTH_INVALID",detail:"La trama identificada es demasiado larga para un título factual completo de YouTube. No se recortó ni reformuló su significado.",source_story:explicit.story};
 const description=explicit.story.replace(/\s+/g," ").trim().replace(/[.!?]+\s*$/,".")+
  "\n\n¿Qué pasará ahora?\n\n"+TAGS;
 return {title,description,episode_excerpt:explicit.evidence.slice(0,500),
  source_story:explicit.story,method:"explicit_current_episode_extractive",
  grounding:"literal_episode_source_operator_review_required",
  warning:"Título y descripción extractivos basados en la TRAMA CENTRAL explícita, sin alterar actores ni acciones. Revisá el video antes de guardar.",
  title_excerpt:coveredStory};
}
export function generateFruttiRecapCopy(fullPrompt){
 const explicit=extractExplicitEpisodeStory(fullPrompt);
 if(explicit)return explicitEpisodeCopy(explicit);
 const input=extract(fullPrompt);
 if(input.error)return input;
 const ev=episodeEvent(input.story);
 if(!ev)return {error:"EPISODE_ACTION_UNCLEAR",detail:"No pude reconocer una acción concreta con personajes en el episodio. No inventé un título ni copié el prompt."};
 const uncertainty=riskyEvent(ev);
 if(uncertainty)return {error:"NARRATIVE_GROUNDING_REQUIRED",detail:uncertainty,episode_excerpt:clean(ev.line).slice(0,500)};
 const copy=narrative(ev,input.story);
 if(!copy)return {error:"EPISODE_ACTION_UNCLEAR",detail:"No pude identificar con certeza quién actúa y a quién afecta. Podés completar el título y la descripción manualmente."};
 const originalHook=clean(input.hook).toUpperCase();
 const usable=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(originalHook)&&!/(DRAMA FAMILIAR|NUEVA CRISIS|GIRO IMPACTANTE)/.test(originalHook);
 const title=makeTitle(usable&&ev.rule.key!=="interrupcion_con_contexto"?originalHook:copy.hook,copy.core)||makeTitle(copy.hook,copy.core);
 if(!title)return {error:"TITLE_LENGTH_INVALID",detail:"No hay espacio suficiente para un título completo de hasta 100 caracteres."};
 return {title,description:copy.description,episode_excerpt:clean(ev.line).slice(0,300),method:"historical_editorial_hook_story_templates",warning:"Borrador por reglas editoriales locales; NO hay un modelo de lenguaje verificando la narrativa. Contrastá cada acontecimiento con el prompt y el video antes de guardar.",grounding:"heuristic_operator_review_required",source_story:input.story.slice(0,1800)};
}
