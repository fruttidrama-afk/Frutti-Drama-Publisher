// FruttiDrama's historical hook + episode story + editorial synopsis approach.
// Reconstructed videos: take ONLY the operator-supplied current episode, never inferred canon.
// No AI API, no credits, no keys, no network, no publication or stock modifications.
const TAGS="#Shorts #ViralShorts #FruttiDrama";
const PEOPLE=/\b(?:Don Mel[oó]n|Lim[oó]n(?: Duarte)?|Uva(?: Reyes)?|Mango(?: Del Rio)?|Fresia|Banana|Bananita|Naranja)\b/gi;
const TECH=/\b(?:9:16|720p|1080p|one continuous|unbroken take|lighting|camera|cinematography|cinematic|framing|shot change|lens|character reference|reference sheet|glitch|subtitles|no duplicates|assets?|lip.?sync|audio ambience|foreground|background|portrait orientation|voice assignment|frame rate|negative prompt|idioma:|constraints:|model intent|exactly one|render this exact|visual style|soft lighting|color grading|plano|iluminaci[oó]n|c[aá]mara|encuadre|sin duplicados)\b/i;
const ACT=/(?:enfrenta|confronta|encara|confronts?|faces?|discute|argues?|advierte|warns?|amenaza|threatens?|besa|besan|kiss(?:es|ed)?|tries to kiss|intenta besar|embaraz\w*|pregnan\w*|le cuenta|hace creer|envenena|poisons?|muere|dies|fallece|da a luz|gives birth|nace|humilla|insulta|humiliates?|insults?|revela|reveals?|confiesa|confesses?|admite|admits?|descubre|discovers?|encuentra|finds?|escucha|overhears?|rechaza|rejects?|refuses?|se niega|promete|promises?|miente|lies?|deceives?|enga[ñn]a|observa|watches?|ve a|sees?|irrumpe|interrumpe|interrupts?|aparece|arrives?|enters?|abandona|leaves?|walks away|expulsa|throws out|le dice|tells?|says?|anuncia|announces?|muestra|shows?|entrega|hands?|llora|cries|acusa|accuses?|celos|jealous)\b/i;
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
function extract(raw){
 const lines=String(raw||"").replace(/\r/g,"").split("\n").map(x=>x.trim());
 let hook="",blocks=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(/^HOOK\s*:/i.test(line))hook=clean(line.slice(line.indexOf(":")+1));
  const inline=line.match(/^(?:EPISODE INTENT|TRAMA|SINOPSIS|STORY|PLOT|EPISODIO ACTUAL|DRAMATIC ACTION)\s*:\s*(.{25,})/i);
  if(inline&&!TECH.test(inline[1]))blocks.push({text:inline[1],weight:10});
  if(!HEADING.test(line))continue;
  const parts=[];
  for(let j=i+1;j<Math.min(lines.length,i+18);j++){
   const s=lines[j];
   if(!s){if(parts.length)break;continue}
   if(STOP.test(s)||HEADING.test(s)||/^[A-Z][A-Z /_-]{9,}$/.test(s)&&parts.length)break;
   if(/^HOOK\s*:/i.test(s)){hook=clean(s.slice(s.indexOf(":")+1));continue}
   const t=s.replace(/^EPISODE INTENT:\s*/i,"");
   if(!TECH.test(t))parts.push(t);
   if(parts.join(" ").length>1600)break;
  }
  if(parts.length)blocks.push({text:parts.join(" "),weight:9});
 }
 const beat=[];
 for(const line of lines){
  const b=line.match(/^(?:SCENE\s*\d+|ESCENA\s*\d+|BEAT\s*\d+|0?[0-9](?::[0-5][0-9])?\s*[-–]\s*0?[0-9](?::[0-5][0-9])?\s*(?:s|sec)?|ACTION|ACCI[OÓ]N)\s*[:–-]?\s*(.+)$/i);
  if(b&&ACT.test(b[1])&&!TECH.test(b[1]))beat.push(b[1]);
 }
 if(beat.length)blocks.push({text:beat.join(". "),weight:7});
 if(!blocks.length){
  let ignoring=false;const found=[];
  for(const line of lines){
   if(STOP.test(line)){ignoring=true;continue}
   if(HEADING.test(line)){ignoring=false;continue}
   if(!ignoring&&ACT.test(line)&&!TECH.test(line)&&names(line).length)found.push(line);
  }
  if(found.length)blocks.push({text:found.slice(0,4).join(". "),weight:2});
 }
 blocks=blocks.map(x=>({text:clean(x.text),weight:x.weight})).filter(x=>x.text.length>23&&ACT.test(x.text)&&!TECH.test(x.text));
 blocks.sort((a,b)=>b.weight-a.weight||a.text.length-b.text.length);
 if(!blocks.length)return {error:"STORY_NOT_FOUND",detail:"No encontré una acción narrativa clara en este prompt. No voy a inventar la trama ni copiar instrucciones técnicas."};
 let story=blocks[0].text;
 const formatted=story.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+)\s*[:：]\s*(.{24,})$/);
 if(formatted){hook=hook||formatted[1];story=formatted[2]}
 return {story:clean(story.slice(0,1450)),hook};
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
 {key:"hablar",re:/le dice|tells?|says? to|anuncia|announces?/i,hook:"PALABRAS DECISIVAS",verb:"habla con",intro:"habla directamente con"}
];
function episodeEvent(story){
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
  core=a+" "+rule.verb+(["veneno","beso","humilla","amenaza"].includes(rule.key)?" a ":" ")+nameAfter;
  desc=a+" "+rule.intro+" "+(["beso","veneno","revela","prueba"].includes(rule.key)?"a ":"")+nameAfter+".";
  if(rule.key==="humilla")desc=a+" humilla a "+nameAfter+". El ataque verbal rompe cualquier apariencia de cordialidad.";
  if(rule.key==="beso")desc=a+" besa a "+nameAfter+". Ese acercamiento marca un giro en su relación.";
  if(rule.key==="enfrenta"&&secondary){
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
function makeTitle(hook,core){
 const capital=clean(hook).toLocaleUpperCase("es");
 if(!/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(capital))return null;
 const candidate=capital+": "+clean(core).replace(/[.!?]+$/,"");
 return [candidate+" "+TAGS,candidate+" #Shorts #FruttiDrama",candidate].find(x=>x.length<=100)||null;
}
export function generateFruttiRecapCopy(fullPrompt){
 const input=extract(fullPrompt);
 if(input.error)return input;
 const ev=episodeEvent(input.story);
 if(!ev)return {error:"EPISODE_ACTION_UNCLEAR",detail:"No pude reconocer una acción concreta con personajes en el episodio. No inventé un título ni copié el prompt."};
 const copy=narrative(ev,input.story);
 if(!copy)return {error:"EPISODE_ACTION_UNCLEAR",detail:"No pude identificar con certeza quién actúa y a quién afecta. Podés completar el título y la descripción manualmente."};
 const originalHook=clean(input.hook).toUpperCase();
 const usable=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(originalHook)&&!/(DRAMA FAMILIAR|NUEVA CRISIS|GIRO IMPACTANTE)/.test(originalHook);
 const title=makeTitle(usable?originalHook:copy.hook,copy.core)||makeTitle(copy.hook,copy.core);
 if(!title)return {error:"TITLE_LENGTH_INVALID",detail:"No hay espacio suficiente para un título completo de hasta 100 caracteres."};
 return {title,description:copy.description,episode_excerpt:clean(ev.line).slice(0,300),method:"historical_editorial_hook_story_templates",warning:"Texto generado mediante la estructura histórica de FruttiDrama, sin proveedores externos. Contrastalo con el video antes de guardar."};
}
