// FruttiDrama operator reconstruction. No generation, approval, queue or YouTube mutations.
export function initFruttiRecap({session,udText}){
 const $=s=>document.querySelector(s);
 const endpoint="https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-recap";
 let files=[],records=new Map(),drafts=new Map(),selected=null;
 const values=()=>({season:$("#udRecapSeason").value,episode:$("#udRecapEpisode").value,generation_prompt:$("#udRecapPrompt").value,title:$("#udRecapTitle").value,description:$("#udRecapDescription").value,note:$("#udRecapNote").value});
 const remember=()=>{if(selected!==null)drafts.set(selected,values())};
 async function request(method,body){
  const s=await session();if(!s?.access_token)throw Error("Volvé a ingresar: sesión no disponible.");
  const r=await fetch(endpoint,{method,headers:{"authorization":"Bearer "+s.access_token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,cache:"no-store"});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw Error((data.detail||data.hint||data.error||"HTTP "+r.status)+(data.error&&data.detail?" ["+data.error+"]":""));return data;
 }
 function summary(){
  $("#udForensicSummary").textContent=files.length+" archivos originales · "+records.size+" fichas en el stock reconstruido · "+Math.max(0,files.length-records.size)+" pendientes.";
 }
 function selectFile(index,switchPane=true){
  if(selected!==null&&selected!==index)remember();
  const f=files.find(x=>x.file_index===index);if(!f)return;
  selected=index;const previous=records.get(index),data=drafts.get(index)||previous||{};
  $("#udRecapSelected").textContent="ARCHIVO "+String(index+1).padStart(2,"0")+" · SHA-256 "+f.sha256_short+"…"+(previous?" · guardado (revisión "+previous.revision+")":" · pendiente");
  const fields=[["udRecapSeason","season"],["udRecapEpisode","episode"],["udRecapPrompt","generation_prompt"],["udRecapTitle","title"],["udRecapDescription","description"],["udRecapNote","note"]];
  for(const [id,key] of fields)$("#"+id).value=data[key]??"";
  $("#udRecapStatus").textContent=previous?"Esta ficha ya existe: podés corregirla sin tocar YouTube.":"Pegá el prompt real y prepará la ficha de este video.";
  $("#udRecapEvidence").textContent="Acción narrativa extraída: pendiente de analizar el prompt.";
  render();
  if(switchPane&&window.matchMedia("(max-width:900px)").matches){
   $("#udRecoveryPanels").classList.add("ud-show-prompts");
   $("#udShowVideos").classList.remove("ud-active");
   $("#udShowPrompts").classList.add("ud-active");
   $("#udRecoveryPane").scrollIntoView({block:"start",behavior:"smooth"});
  }
 }
 function renderStock(){
  const root=$("#udRecapStockList");root.replaceChildren();
  const sorted=[...records.values()].sort((a,b)=>a.season-b.season||a.episode-b.episode);
  if(!sorted.length){root.append(udText("p","udmuted","Todavía no se guardó ninguna ficha. Los 31 videos originales siguen preservados."));return}
  for(const v of sorted){
   const btn=udText("button","ud-recap-record","T"+v.season+" · E"+String(v.episode).padStart(2,"0")+" · "+v.title);
   btn.type="button";btn.append(udText("small","","Archivo "+String(v.file_index+1).padStart(2,"0")+" · revisión "+v.revision+" · sin publicación automática"));
   btn.onclick=()=>selectFile(v.file_index);root.append(btn);
  }
 }
 function render(){
  const box=$("#udForensicItems");box.replaceChildren();
  const filter=$("#udForensicFilter").value,needle=$("#udForensicSearch").value.toLowerCase().trim();
  const shown=files.filter(f=>{
   const saved=records.get(f.file_index);
   return (filter==="all"||(filter==="assigned"&&saved)||(filter==="pending"&&!saved))&&(!needle||[f.file_index+1,f.transcript_raw,saved?.title].join(" ").toLowerCase().includes(needle));
  });
  if(!shown.length){box.append(udText("p","udmuted","Sin videos para estos filtros."));return}
  for(const f of shown){
   const article=udText("article","ud-forensic-item"),saved=records.get(f.file_index);
   if(f.contact_image_url){const img=document.createElement("img");img.src=f.contact_image_url;img.loading="lazy";img.alt="Fotogramas del archivo "+(f.file_index+1);article.append(img)}
   const body=udText("div","ud-forensic-item-body");
   body.append(udText("strong","","ARCHIVO "+String(f.file_index+1).padStart(2,"0")));
   body.append(udText("span","ud-forensic-tag",saved?"T"+saved.season+" E"+saved.episode+" · GUARDADO":"SIN IDENTIFICAR"));
   if(f.video_url){
    const play=udText("button","ud-small-button","▶ REPRODUCIR VIDEO ORIGINAL");play.type="button";
    play.onclick=()=>{
     const old=article.querySelector("video");
     if(old){old.remove();play.textContent="▶ REPRODUCIR VIDEO ORIGINAL";return}
     for(const v of document.querySelectorAll("#udForensicItems video"))v.pause();
     const vid=document.createElement("video");vid.controls=true;vid.playsInline=true;vid.preload="none";vid.src=f.video_url;
     vid.setAttribute("aria-label","Archivo "+(f.file_index+1));play.after(vid);play.textContent="OCULTAR VIDEO";
    };body.append(play);
   }else body.append(udText("small","udmuted","El video no está disponible temporalmente. Actualizá el panel."));
   body.append(udText("div","ud-forensic-speech","DIÁLOGO: “"+(f.transcript_raw||"Sin texto detectado")+"”"));
   body.append(udText("small","udmuted","SHA-256 "+f.sha256_short+"… · sin cambios al MP4"));
   const b=udText("button","ud-recap-select"+(selected===f.file_index?" ud-active":""),saved?"ABRIR FICHA GUARDADA":"IDENTIFICAR ESTE VIDEO");
   b.type="button";b.onclick=()=>selectFile(f.file_index);body.append(b);article.append(body);box.append(article);
  }
 }
 async function load(input){
  files=input||[];
  const response=await request("GET");records=new Map((response.items||[]).map(v=>[v.file_index,v]));
  summary();render();renderStock();
  $("#udForensicStatus").textContent="Listo. Los prompts de planificación fueron retirados de esta sección. Seleccioná un archivo y pegá el verdadero prompt.";
  if(selected!==null)selectFile(selected,false);
  $("#udForensicFilter").onchange=render;$("#udForensicSearch").oninput=render;
 }
 async function suggest(){
  if(selected===null){$("#udRecapStatus").textContent="Elegí un archivo primero.";return}
  const prompt=$("#udRecapPrompt").value.trim();
  if(prompt.length<20){$("#udRecapStatus").textContent="Pegá el prompt original antes de generar la propuesta.";return}
  const btn=$("#udRecapSuggest");btn.disabled=true;btn.textContent="GENERANDO CON IA…";$("#udRecapStatus").textContent="Consultando modelo de lenguaje: interpretando la historia y redactando título y descripción…";
  try{
   const data=await request("POST",{action:"suggest",generation_prompt:prompt});
   if(data.error){$("#udRecapEvidence").textContent="Acción no confirmada"+(data.episode_excerpt?": "+data.episode_excerpt:" · no se reutilizan instrucciones técnicas.");$("#udRecapStatus").textContent=data.detail||data.error;return}
   $("#udRecapEvidence").textContent="Acción encontrada en EPISODE/TRAMA (revisala contra el video): "+String(data.episode_excerpt||"sin detalle");
   $("#udRecapTitle").value=data.title;$("#udRecapDescription").value=data.description;remember();
   $("#udRecapStatus").textContent=data.warning||"Borrador listo. Comprobá y editá el título y la descripción antes de guardar.";
  }catch(e){$("#udRecapStatus").textContent="La IA no pudo generar el paquete: "+String(e.message||e);$("#udRecapEvidence").textContent="No se generaron metadatos: no se usarán borradores automáticos ni plantillas como sustituto."}
  finally{btn.disabled=false;btn.textContent="GENERAR PROPUESTA DESDE PROMPT"}
 }
 async function save(){
  const f=files.find(x=>x.file_index===selected);if(!f){$("#udRecapStatus").textContent="Seleccioná un video.";return}
  const v=values(),season=Number(v.season),episode=Number(v.episode);
  if(![2,3].includes(season)||!Number.isInteger(episode)||episode<1||episode>25){$("#udRecapStatus").textContent="Temporada 2 o 3 y número de episodio entre 1 y 25.";return}
  if(v.generation_prompt.trim().length<20||!v.title.trim()||!v.description.trim()){$("#udRecapStatus").textContent="Completá el prompt original, el título y la descripción.";return}
  const conflict=[...records.values()].find(r=>r.file_index!==selected&&r.season===season&&r.episode===episode);
  if(conflict){$("#udRecapStatus").textContent="T"+season+"E"+episode+" ya corresponde al archivo "+(conflict.file_index+1)+". Elegí la versión definitiva.";return}
  remember();
  const btn=$("#udRecapSave");btn.disabled=true;btn.textContent="GUARDANDO…";
  try{
   const old=records.get(selected);
   const answer=await request("POST",{action:"save",file_index:selected,source_sha256:f.source_sha256,season,episode,generation_prompt:v.generation_prompt,title:v.title,description:v.description,note:v.note,expected_revision:old?.revision??null});
   if(!answer.saved)throw Error("El servidor no confirmó el guardado");
   drafts.delete(selected);
   await load(files);
   $("#udRecapStatus").textContent="✓ GUARDADO: T"+season+"E"+episode+" · archivo "+(selected+1)+". Stock reconstruido actualizado; YouTube y MP4 intactos.";
  }catch(e){$("#udRecapStatus").textContent="NO SE GUARDÓ: "+String(e.message||e)}
  finally{btn.disabled=false;btn.textContent="GUARDAR EN STOCK RECONSTRUIDO"}
 }
 for(const id of ["udRecapSeason","udRecapEpisode","udRecapPrompt","udRecapTitle","udRecapDescription","udRecapNote"])$("#"+id).addEventListener("input",remember);
 $("#udRecapSuggest").onclick=suggest;$("#udRecapSave").onclick=save;
 return {load,render};
}
