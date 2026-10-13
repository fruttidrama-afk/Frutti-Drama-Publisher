import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
const BASE=Deno.env.get("SUPABASE_URL")!;
const admin=createClient(BASE,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const authClient=createClient(BASE,Deno.env.get("SUPABASE_ANON_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const PID="7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7";
const MANIFEST="forensics/2026-10-12/fruttidrama/reconciliation-v2";
const TABLE="publisher_frutti_reconstructed_stock";
const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type,apikey,x-client-info","cache-control":"no-store"};
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json;charset=utf-8"}})}
const tidy=(s:string)=>s.replace(/\s+/g," ").trim();
// Extract ONLY the new episode's action, never preceding CANON, camera rules or negative prompts.
// The old factory emitted EPISODE\n<HOOK>: <EVENT>\n\nNARRATIVE NOVELTY LOCK.
function extractEpisode(raw:string){
 const lines=String(raw||"").replace(/\r/g,"").split("\n").map(x=>x.trim());
 const technical=/\b(one continuous scene|unbroken take|9:16|vertical|hyperrealistic|lighting|camera|cinematography|reference sheet|character sheet|shot|ambient audio|lips|dialogue when spoken|glitch|no duplicates|no subtitles|warm grading|must never|do not|always use|use only|modelo|generaci[oó]n|cr[eé]ditos|c[aá]mara|iluminaci[oó]n|plano|audio ambiente)\b/i;
 const nextSection=/^(CANON\b|CONTINUITY\b|VISUAL\b|LOCATION\b|TONE\b|NARRATIVE NOVELTY|EXACT 10|STRICT ANTI|FLOW CHARACTER|CHARACTER REFERENCES|REFERENCE SHEETS|ANTI.GLITCH|AVOID|NEGATIVE|TECHNICAL|DIALOGUE RULES|AUDIO RULES|BACKGROUND|SETTING RULES)/i;
 const narrativeHeader=/^(EPISODE|EPISODIO(?: ACTUAL)?|EPISODE STORY|HISTORIA DEL EPISODIO|TRAMA PRINCIPAL|ESCENA CENTRAL|CONFLICTO PRINCIPAL|STORY|STORYLINE|PLOT|EPISODE INTENT|NARRATIVE BEAT)\s*[:：-]?\s*$/i;
 const inlineHeader=/^(?:EPISODE STORY|HISTORIA DEL EPISODIO|TRAMA PRINCIPAL|EPISODE INTENT|NARRATIVE BEAT|SINOPSIS|ARGUMENTO|CONFLICTO PRINCIPAL|EPISODE PLOT|PLOT|STORY|TRAMA)\s*[:：]\s*(.{35,})$/i;
 let segments:{content:string,kind:string,weight:number}[]=[];
 for(let i=0;i<lines.length;i++){
  const l=lines[i];
  const m=l.match(inlineHeader);
  if(m&&!technical.test(m[1]))segments.push({content:m[1],kind:"inline",weight:3});
  if(!narrativeHeader.test(l))continue;
  const picked:string[]=[];
  for(let j=i+1;j<Math.min(i+10,lines.length);j++){
   const n=lines[j];
   if(!n){if(picked.length)break;continue}
   if(nextSection.test(n)||narrativeHeader.test(n)||/^[A-Z][A-Z /_-]{8,}$/.test(n)&&picked.length)break;
   if(!technical.test(n))picked.push(n);
   if(picked.join(" ").length>800)break;
  }
  if(picked.length)segments.push({content:picked.join(" "),kind:l,weight:/^EPISODE$/i.test(l)?5:4});
 }
 // If the prompt does not have the historical EPISODE section, support explicit
 // storyboard action and spoken turns; do not take incidental world/canon paragraphs.
 if(!segments.length){
  const scene=/^(?:SCENE\s*\d+|ESCENA\s*\d+|BEAT\s*\d+|ACCI[OÓ]N|ACTION|DRAMATIC ACTION)\s*[:：-]\s*(.+)$/i;
  const beats:string[]=[];
  for(const l of lines){
   const m=l.match(scene);
   if(m&&!technical.test(m[1]||"")&&!technical.test(m[2]))beats.push(m[2].trim());
  }
  if(beats.length)segments.push({content:beats.join(". "),kind:"storyboard",weight:2});
 }
 if(!segments.length)return {error:"TRAMA_NO_IDENTIFICABLE",detail:"El prompt no contiene un bloque de trama claro (EPISODE / TRAMA / ESCENA). Para evitar inventar, no generé metadatos. Podés escribirlos manualmente o añadir un resumen fiel de lo que ocurre en el video."};
 segments.sort((a,b)=>b.weight-a.weight||a.content.length-b.content.length);
 let content=segments[0].content.replace(/^["'“”]+|["'“”]+$/g,"").trim();
 let hook="";
 const pair=content.match(/^([A-ZÁÉÍÓÚÜÑ0-9]+)\s+([A-ZÁÉÍÓÚÜÑ0-9]+)\s*[:：–-]\s*(.{25,})$/);
 if(pair){hook=pair[1]+" "+pair[2];content=pair[3].trim()}
 if(content.length<35||technical.test(content))return {error:"TRAMA_NO_IDENTIFICABLE",detail:"Encontré instrucciones técnicas, pero no una acción narrativa suficientemente concreta. No voy a crear un título genérico ni pegar el prompt en la descripción."};
 return {story:content.slice(0,1400),hook,source:segments[0].kind};
}
const realNames=["Fresia","Mango","Banana","Uva","Limón","Bananita","Naranja","Don Melón"];
function hasName(s:string,n:string){return new RegExp("\\b"+n.replace(/[óáéíú]/g,".")+"\\b","i").test(s)}
function chooseTitle(hook:string,core:string){
 const tags=" #Shorts #ViralShorts #FruttiDrama";
 const candidates=[hook+": "+core+tags,hook+": "+core+" #Shorts #FruttiDrama",hook+": "+core];
 return candidates.find(s=>s.length<=100)||null;
}
type Copy={hook:string,core:string,description:string,question:string};
function makeNarrativeCopy(s:string,desiredHook:string):Copy|null{
 const name=(n:string)=>hasName(s,n);
 const duo=(a:string,b:string)=>name(a)&&name(b);
 const relation=/\b(hijo|beb[eé]|padre|madre|co.?parent|parentalidad)\b/i.test(s);
 const specific:Array<[RegExp,Copy]>=[
  [/don mel[oó]n.*(?:escucha|oye|escuch[oó]).*fresia.*(?:siente|sentimientos|ama|amor).*(?:lim[oó]n)/i,
   {hook:"SECRETO ESCUCHADO",core:"Don Melón descubre los sentimientos de Fresia",description:"Don Melón oye a Fresia admitir que todavía siente algo por Limón. Aunque no interviene, comprende que ese secreto podría alterar la tranquilidad de la familia.",question:"¿Intervendrá Don Melón antes de que el conflicto estalle?"}],
  [/don mel[oó]n.*(?:confronta|enfrenta|advierte|exige|proh[ií]be).{0,100}fresia.*(?:uva|lim[oó]n|relaci[oó]n)/i,
   {hook:"ADVERTENCIA FAMILIAR",core:"Don Melón exige que Fresia respete a Uva",description:"Don Melón confronta a Fresia y le advierte que no interfiera en la relación entre Uva y Limón. Fresia asegura que no hará nada, pero la tensión deja abiertas nuevas dudas.",question:"¿Podrá Fresia cumplir lo que prometió?"}],
  [/uva.*(?:escucha|oye|o[ií]do).{0,120}(?:fresia|lim[oó]n).*?(?:tri[aá]ngulo|teme|duda|elig[ií]|explica)/i,
   {hook:"DUDA AMOROSA",core:"Uva escucha algo que la hace dudar de Limón",description:"Uva oye parte de una conversación entre Fresia y Limón y teme volver a un triángulo amoroso. Limón intenta aclararle que su elección es estar con ella.",question:"¿Podrá Uva confiar en la palabra de Limón?"}],
  [/lim[oó]n.*(?:reafirma|declara|anuncia|elige).{0,120}uva.*?(?:fresia|delante|frente|futuro)/i,
   {hook:"ELECCIÓN DEFINITIVA",core:"Limón elige a Uva frente a Fresia",description:"Limón deja clara su decisión delante de Uva y Fresia: quiere construir un futuro junto a Uva. Fresia queda frente a una elección que ya no puede ignorar.",question:"¿Cómo reaccionará Fresia al escuchar la decisión de Limón?"}],
  [/fresia.*(?:admite|confiesa|reconoce).{0,120}uva.*(?:siente|sentimientos|ama|amor).{0,90}lim[oó]n/i,
   {hook:"CONFESIÓN INCÓMODA",core:"Fresia admite ante Uva que todavía ama a Limón",description:"Fresia reconoce ante Uva que aún siente algo por Limón. Lejos de retroceder, Uva le exige que respete la relación que él eligió.",question:"¿Conseguirá Fresia dejar atrás sus sentimientos?"}],
  [/lim[oó]n.*(?:busca|promete|jura|asegura).{0,100}uva.*(?:mentiras|transparencia|confianza|verdad)/i,
   {hook:"PROMESA DIFÍCIL",core:"Limón promete sinceridad a Uva",description:"Limón busca a Uva para prometerle que no repetirá los engaños del pasado. Ella acepta seguir adelante, pero deja una condición: transparencia absoluta.",question:"¿Podrá Limón demostrar que esta vez es distinto?"}],
  [/uva.*lim[oó]n.*bananita.*(?:familia|jard[ií]n|tarde|juntos)/i,
   {hook:"NUEVA FAMILIA",core:"Uva, Limón y Bananita comparten un nuevo comienzo",description:"Uva, Limón y Bananita disfrutan juntos un momento que refleja la familia que están formando. Sin embargo, la mirada de Fresia deja entrever que la calma podría durar poco.",question:"¿Podrán proteger esta nueva etapa de los celos?"}],
  [/uva.*lim[oó]n.*(?:besan|beso).*fresia.*(?:ve|aparece|observa|descubre|sorprende)/i,
   {hook:"BESO INTERRUMPIDO",core:"Fresia sorprende el beso de Uva y Limón",description:"Uva y Limón se besan en el jardín de la hacienda, pero Fresia aparece y presencia el momento. Lo que debía ser íntimo despierta una reacción que puede complicar su futuro.",question:"¿Qué hará Fresia después de descubrirlos?"}],
  [/fresia.*(?:enfrenta|confronta|reclama).{0,110}lim[oó]n.*(?:hijo|beb[eé]|padre).*(?:termin[oó]|terminada|acab[oó]|separad)/i,
   {hook:"RELACIÓN TERMINADA",core:"Limón aclara a Fresia que solo serán padres",description:"Fresia reclama a Limón por el vínculo que aún los une como padres. Él le asegura que estará presente para su hijo, pero deja claro que su relación sentimental ya terminó.",question:"¿Aceptará Fresia esta nueva realidad?"}]
 ];
 for(const [re,v] of specific)if(re.test(s))return v;
 const patterns:Array<[RegExp,Copy]>=[
  [/fresia.*(?:confronta|enfrenta|advierte|encara|le dice|le recuerda|le asegura).{0,150}uva|uva.*(?:confronta|enfrenta|advierte).{0,150}fresia/i,
   {hook:"CELOS DECLARADOS",core:"Fresia enfrenta a Uva por su vínculo con Limón",description:"Fresia encara a Uva y le recuerda que Limón seguirá ligado a ella por su hijo. Uva se niega a competir por él y defiende una relación basada en hechos, no en promesas.",question:"¿Conseguirá Fresia sembrar dudas entre Uva y Limón?"}],
  [/fresia.*(?:lim[oó]n).*(?:hijo|beb[eé]|padre).*(?:nunca|jam[aá]s|no volver|no ser[aá]n|l[ií]mite)|lim[oó]n.*(?:fresia).*(?:hijo|beb[eé]|padre).*(?:nunca|jam[aá]s|no volver|no ser[aá]n|l[ií]mite)/i,
   {hook:"LÍMITE DEFINITIVO",core:"Limón rechaza volver con Fresia",description:"Limón deja claro que seguirá presente en la vida de su hijo, pero que eso no significa retomar su relación con Fresia. Ella debe enfrentar un rechazo que altera el equilibrio en la hacienda.",question:"¿Aceptará Fresia que Limón eligió otro camino?"}],
  [/fresia.*(?:mango).*(?:embaraz|beb[eé]|hijo|paternidad).*(?:mentira|oculta|enga[ñn]|cree que|hace creer)|fresia.*(?:embaraz).*(?:mango).*(?:mentira|oculta|enga[ñn]|cree que)/i,
   {hook:"MENTIRA PELIGROSA",core:"Fresia engaña a Mango sobre su embarazo",description:"Fresia sostiene una mentira sobre la paternidad de su bebé ante Mango. Cuanto más se compromete con esa versión, más difícil se vuelve ocultar la verdad.",question:"¿Qué ocurrirá cuando Mango descubra quién es el padre?"}],
  [/fresia.*(?:lim[oó]n).*(?:embaraz|beb[eé]|hijo|paternidad)|lim[oó]n.*fresia.*(?:embaraz|beb[eé]|hijo|paternidad)/i,
   {hook:"SECRETO MATERNAL",core:"Fresia y Limón enfrentan el secreto de su bebé",description:"El embarazo de Fresia obliga a ella y a Limón a hablar de una verdad capaz de afectar sus relaciones. El futuro del bebé vuelve imposible seguir evitando el conflicto.",question:"¿Cuánto tiempo podrán mantener este secreto?"}],
  [/banana.*(?:envenen|veneno).*(?:mango)|mango.*(?:envenen|veneno).*(?:banana)/i,
   {hook:"VENENO MORTAL",core:"Mango envenena a Banana",description:"Mango cruza un límite irreversible y convierte a Banana en víctima de su plan. Las consecuencias del envenenamiento amenazan con destruir a toda la familia.",question:"¿Hasta dónde llegará la traición de Mango?"}],
  [/banana.*(?:diagn[oó]stico|bananismo m[uú]ltiple|hospital|enfermedad)/i,
   {hook:"DIAGNÓSTICO DEVASTADOR",core:"Banana enfrenta el bananismo múltiple",description:"La salud de Banana se deteriora y un diagnóstico de bananismo múltiple cambia su vida. La familia enfrenta el miedo y la incertidumbre ante su enfermedad.",question:"¿Podrá Banana superar el diagnóstico?"}],
  [/(?:banana.*(?:muere|fallece|pierde la vida)|muerte.*banana|despedida.*banana)/i,
   {hook:"ADIÓS BANANA",core:"La muerte de Banana sacude a la familia",description:"La muerte de Banana deja una pérdida imposible de ignorar. Uva y el resto de la familia deben continuar con las consecuencias de una tragedia que cambia sus vidas.",question:"¿Cómo seguirá la familia después de esta despedida?"}],
  [/uva.*(?:lim[oó]n).*(?:beso|besa|besan|besarse)|lim[oó]n.*uva.*(?:beso|besa|besan|besarse)/i,
   {hook:"BESO REVELADOR",core:"Uva y Limón se besan ante una nueva oportunidad",description:"Uva y Limón dejan atrás sus dudas y se acercan con un beso que marca una nueva etapa. Ese gesto puede alterar las relaciones dentro de la hacienda.",question:"¿Podrán vivir su historia sin que los celos interfieran?"}],
  [/(?:fresia|mango).*(?:ve|sorprende|descubre).*(?:beso|bes[aá]ndose).*(?:lim[oó]n|uva)|(?:beso|besan).*(?:fresia).*(?:ve|descubre|sorprende)/i,
   {hook:"BESO DESCUBIERTO",core:"Fresia presencia el beso de Uva y Limón",description:"Uva y Limón comparten un beso que parecía privado, pero Fresia lo presencia. Su reacción abre una nueva tensión que amenaza la calma de la hacienda.",question:"¿Qué hará Fresia después de verlos juntos?"}],
  [/uva.*lim[oó]n.*(?:oportunidad|empezar de nuevo|nueva etapa|acercan|reconcili)|lim[oó]n.*uva.*(?:oportunidad|empezar de nuevo|nueva etapa|acercan|reconcili)/i,
   {hook:"SEGUNDA OPORTUNIDAD",core:"Uva y Limón deciden acercarse de nuevo",description:"Después de todo lo que vivieron, Uva y Limón eligen darse otra oportunidad. La decisión abre una etapa distinta para ambos y para la vida en la hacienda.",question:"¿Podrán construir una relación lejos de los conflictos?"}],
  [/naranja.*(?:muestra|revela|expone|descubre|entrega).*(?:foto|prueba|trampa|mensaje)|(?:foto|prueba|trampa).*(?:naranja).*(?:revela|expone|entrega|muestra)/i,
   {hook:"TRAMPA REVELADA",core:"Naranja presenta una prueba inesperada",description:"Naranja saca a la luz una prueba que cambia lo que otros creían saber. Su revelación pone nuevas sospechas sobre la mesa y provoca una reacción inmediata.",question:"¿Quién quedará expuesto por lo que encontró Naranja?"}],
  [/banana.*(?:intenta besar|besar|bes[oó]).*(?:fresia)|fresia.*(?:intento de beso|besar).*(?:banana)/i,
   {hook:"BESO PROHIBIDO",core:"Banana intenta besar a Fresia",description:"Banana se acerca a Fresia de una manera que cruza los límites de su relación. Su intento de beso amenaza con provocar una ruptura de confianza dentro de la hacienda.",question:"¿Quién se enterará de lo que pasó entre ellos?"}],
  [/(?:foto|imagen).*(?:banana).*(?:fresia).*?(?:beso|besar)|(?:mango).*(?:foto|imagen).*(?:banana).*(?:fresia)/i,
   {hook:"FOTO COMPROMETEDORA",core:"Mango encuentra una prueba contra Banana",description:"Una fotografía revela el intento de Banana de besar a Fresia. Mango descubre lo ocurrido y la tensión familiar escala ante una traición inesperada.",question:"¿Cómo reaccionará Mango a lo que vio?"}],
  [/fresia.*(?:humilla|insulta|agrede).*(?:uva)|uva.*(?:humillada|insultada).*(?:fresia)/i,
   {hook:"HUMILLACIÓN CRUEL",core:"Fresia humilla a Uva sin piedad",description:"Fresia transforma sus celos en un ataque directo contra Uva. La humillación desata un enfrentamiento que deja al descubierto la tensión entre ambas.",question:"¿Cómo responderá Uva a esta provocación?"}],
  [/mango.*(?:confiesa|admite|revela).*(?:veneno|envenenamiento|banana)/i,
   {hook:"CONFESIÓN TERRIBLE",core:"Mango admite la verdad sobre Banana",description:"Mango revela su responsabilidad en el envenenamiento de Banana. La confesión convierte un secreto oscuro en una verdad que puede cambiar el destino de la familia.",question:"¿Quién será capaz de enfrentar a Mango después de escucharlo?"}],
  [/(?:parto|da a luz|nacimiento|nace el beb[eé]|nace el hijo)/i,
   {hook:"BEBÉ REVELADOR",core:"El nacimiento desata una nueva verdad familiar",description:"La llegada del bebé convierte viejas sospechas en preguntas imposibles de esquivar. La familia debe enfrentar lo que el nacimiento revela sobre sus vínculos.",question:"¿Quién asumirá la verdad sobre este bebé?"}]
 ];
 // More specific actual-event outcomes outrank broad medical or relationship words.
 const finalEvent=patterns.find(([_,v])=>v.hook==="ADIÓS BANANA");
 if(finalEvent&&finalEvent[0].test(s))return finalEvent[1];
 const confession=patterns.find(([_,v])=>v.hook==="CONFESIÓN TERRIBLE");
 if(confession&&confession[0].test(s))return confession[1];
 const photo=patterns.find(([_,v])=>v.hook==="FOTO COMPROMETEDORA");
 if(photo&&photo[0].test(s))return photo[1];
 for(const [re,v] of patterns){
  if(v.hook==="CELOS DECLARADOS"&&!name("Limón"))continue;
  if(re.test(s))return v;
 }
 // Narrow, evidence-based cases only. No meaningless "new crisis" fallback.
 const lower=s.toLowerCase();
 const has=(re:RegExp)=>re.test(lower);
 if(duo("Fresia","Uva")&&has(/(?:encara|enfrenta|confronta|discute|enfrentamiento)/)&&has(/(?:lim[oó]n|relaci[oó]n|hijo|celos)/))
  return {hook:"RIVALIDAD ABIERTA",core:"Fresia y Uva se enfrentan por Limón",description:"La tensión entre Fresia y Uva estalla cuando la relación con Limón queda en el centro de su disputa. Ninguna quiere ceder ante los reclamos de la otra.",question:"¿Podrán encontrar una salida a este conflicto?"};
 if(duo("Uva","Limón")&&has(/(?:rechaza|elige|decide|pide|teme|explica|aclara)/)&&has(/(?:fresia|tri[aá]ngulo|relaci[oó]n|celos)/))
  return {hook:"DECISIÓN SENTIMENTAL",core:"Limón aclara qué lugar ocupa Uva en su vida",description:"Uva exige certezas ante los conflictos del pasado, y Limón debe aclarar qué relación quiere construir con ella. Sus decisiones ponen a prueba la confianza entre ambos.",question:"¿Logrará Limón demostrar que sus palabras son sinceras?"};
 return null;
}
function draftFromPrompt(raw:string){
 const info=extractEpisode(raw);
 if("error" in info)return info;
 const story=info.story;
 const copy=makeNarrativeCopy(story,info.hook);
 if(!copy)return {error:"NECESITA_TRAMA_VERIFICABLE",detail:"Encontré el bloque narrativo, pero no pude convertirlo con seguridad en una sinopsis específica. No generé textos genéricos ni copié líneas del prompt. Revisá la acción del video y redactá la ficha manualmente.",episode_excerpt:story.slice(0,260)};
 // The source-supplied hook must still be a fitting, two-word title, but the
 // editorial copy must be grounded in this exact episode's action.
 const hook=info.hook&&/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/.test(info.hook)?info.hook:copy.hook;
 const title=chooseTitle(hook,copy.core)||chooseTitle(copy.hook,copy.core);
 if(!title)return {error:"TITLE_OVERLENGTH",detail:"No hay una versión del título que entre en 100 caracteres sin recortar el sentido. Editá el título manualmente."};
 const description=copy.description+"\n\n"+copy.question+"\n\n#Shorts #ViralShorts #FruttiDrama";
 return {title,description,method:"editorial_evidence_rules_v3",episode_excerpt:story.slice(0,340),warning:"Propuesta narrativa basada en la acción identificada; confirmá que el video REAL muestra estos hechos antes de guardar."};
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(req.method!=="GET"&&req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 try{
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer "))return json({error:"LOGIN_REQUIRED"},401);
  const {data:auth,error:authError}=await authClient.auth.getUser(h.slice(7));
  const owner=auth?.user?.id;
  if(authError||!owner)return json({error:"LOGIN_INVALID"},401);
  const {data:pub,error:pubError}=await admin.from("publisher_runtime_publishers").select("id").eq("id",PID).eq("owner_id",owner).maybeSingle();
  if(pubError||!pub)return json({error:"FORBIDDEN"},403);
  if(req.method==="GET"){
   const {data,error}=await admin.from(TABLE).select("file_index,source_sha256,season,episode,generation_prompt,prompt_provenance,title,description,metadata_method,note,record_status,publication_status,revision,updated_at,created_at").eq("publisher_id",PID).order("season").order("episode");
   return error?json({error:"READ_FAILED"},503):json({items:data||[],publication_boundary:{season:2,episode:8},publication_queue_unchanged:true});
  }
  const b=await req.json().catch(()=>null);
  if(!b||typeof b!=="object")return json({error:"INVALID_BODY"},400);
  const prompt=String(b.generation_prompt||"").trim();
  if(b.action==="suggest"){
   if(prompt.length<20||prompt.length>50000)return json({error:"PROMPT_LENGTH_INVALID"},400);
   return json(draftFromPrompt(prompt));
  }
  if(b.action!=="save")return json({error:"UNKNOWN_ACTION"},400);
  const idx=b.file_index,season=b.season,episode=b.episode;
  if(!Number.isInteger(idx)||idx<0||idx>30||!Number.isInteger(season)||season<2||season>6||!Number.isInteger(episode)||episode<1||episode>25)return json({error:"IDENTIFICATION_INVALID"},400);
  if(prompt.length<20||prompt.length>50000)return json({error:"PROMPT_LENGTH_INVALID"},400);
  const title=tidy(String(b.title||"")),description=String(b.description||"").trim(),note=String(b.note||"").trim();
  if(/^DRAMA FAMILIAR:|^GIRO IMPACTANTE:/i.test(title)||/\b(?:one continuous scene|unbroken take|cinematic shot|camera movement|character reference sheets|9:16 vertical|no duplicates|ambient audio)\b/i.test(description))
   return json({error:"COPY_NOT_NARRATIVE",hint:"El título debe explicar el suceso real, y la descripción debe narrar la trama, sin copiar instrucciones técnicas."},400);
  if(title.length<12||title.length>100||!/^([A-ZÁÉÍÓÚÜÑ0-9]+) ([A-ZÁÉÍÓÚÜÑ0-9]+):\s+.+/.test(title)||title.includes("…")||title.includes("..."))return json({error:"TITLE_FORMAT_INVALID",hint:"DOS PALABRAS EN MAYÚSCULAS: oración completa. Máximo 100 caracteres."},400);
  if(description.length<12||description.length>4000)return json({error:"DESCRIPTION_INVALID"},400);
  if(note.length>700)return json({error:"NOTE_TOO_LONG"},400);
  const {data:src,error:srcErr}=await admin.from("publisher_factory_knowledge").select("content").eq("key",MANIFEST).eq("active",false).single();
  if(srcErr||!src?.content)return json({error:"EVIDENCE_UNAVAILABLE"},503);
  const archive=JSON.parse(src.content),entries=archive?.items;
  if(!Array.isArray(entries)||entries.length!==31)return json({error:"EVIDENCE_INCOMPLETE"},503);
  const original=entries.find((e:any)=>Number(e.file_index)===idx);
  const digest=String(original?.sha256||"").toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(digest)||digest!==String(b.source_sha256||""))return json({error:"VIDEO_SOURCE_MISMATCH"},409);
  const {data:old,error:oldErr}=await admin.from(TABLE).select("revision,source_sha256").eq("publisher_id",PID).eq("file_index",idx).maybeSingle();
  if(oldErr)return json({error:"PRE_SAVE_CHECK_FAILED"},503);
  if(old&&old.source_sha256!==digest)return json({error:"VIDEO_REPLACEMENT_FORBIDDEN"},409);
  if(old&&b.expected_revision!==old.revision)return json({error:"STALE_EDIT_REFRESH_REQUIRED"},409);
  if(!old&&b.expected_revision!=null)return json({error:"STALE_EDIT_REFRESH_REQUIRED"},409);
  const row={publisher_id:PID,file_index:idx,source_sha256:digest,season,episode,generation_prompt:prompt,prompt_provenance:"operator_copied_google_flow",title,description,metadata_method:"operator_reviewed",note,record_status:"reconstructed_unapproved",publication_status:"unverified",assigned_by:owner,revision:old?old.revision+1:1,updated_at:new Date().toISOString()};
  const {data:saved,error:saveError}=await admin.from(TABLE).upsert(row,{onConflict:"publisher_id,file_index"}).select("file_index,season,episode,revision,updated_at,title,description").single();
  if(saveError){if(saveError.code==="23505")return json({error:"EPISODE_ALREADY_ASSIGNED_TO_ANOTHER_VIDEO"},409);return json({error:"RECONSTRUCTED_STOCK_SAVE_FAILED"},503)}
  return json({saved:true,record:saved,reconstructed_stock:true,publication_queue_unchanged:true,media_unmodified:true});
 }catch(_){return json({error:"UNEXPECTED_RECAP_ERROR"},500)}
});