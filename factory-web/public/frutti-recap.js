// FruttiDrama: human visual identification; NO AI analysis of prompts and NO title generation.
// Historical T2 metadata may be restored exactly. Otherwise only an empty canonical
// scaffold is provided for the operator to fill after WATCHING the real video.
export const FRUTTI_TITLE_HASHTAGS="#Shorts #ViralShorts #FruttiDrama";
export const FRUTTI_MANUAL_TITLE="GANCHO CENTRAL: [describí el hecho] "+FRUTTI_TITLE_HASHTAGS;
export const FRUTTI_MANUAL_DESCRIPTION="[Contá qué sucede en el video y a quién afecta.]\n\n"+FRUTTI_TITLE_HASHTAGS;
const historicalKey=(season,episode)=>String(Number(season))+":"+String(Number(episode));
const synopsisNotAllowed=/\[[^\]]+\]|GANCHO CENTRAL/i;
export function initFruttiRecap({session,udText}){
 const $=s=>document.querySelector(s);
 const endpoint="https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-recap";
 let files=[],records=new Map(),drafts=new Map(),historical=new Map(),selected=null;
 const fields=["udRecapSeason","udRecapEpisode","udRecapPrompt","udRecapTitle","udRecapDescription","udRecapNote"];
 const values=()=>({
  season:$("#udRecapSeason").value,episode:$("#udRecapEpisode").value,
  generation_prompt:$("#udRecapPrompt").value,title:$("#udRecapTitle").value,
  description:$("#udRecapDescription").value,note:$("#udRecapNote").value
 });
 const remember=()=>{if(selected!==null)drafts.set(selected,values())};
 const h=()=>historical.get(historicalKey($("#udRecapSeason").value,$("#udRecapEpisode").value))||null;
 const info=(message)=>{$("#udRecapMethodStatus").textContent=message};
 async function request(method,body){
  const s=await session();if(!s?.access_token)throw Error("Volvé a iniciar sesión para continuar.");
  const r=await fetch(endpoint,{method,headers:{"authorization":"Bearer "+s.access_token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,cache:"no-store"});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error([data.hint,data.detail,data.error||"HTTP "+r.status].filter(Boolean).join(" · "));
  return data;
 }
 function updateCounters(){
  const title=$("#udRecapTitle").value,description=$("#udRecapDescription").value;
  $("#udRecapTitleCounter").textContent=title.length+"/100 caracteres, incluidos los hashtags";
  $("#udRecapDescriptionCounter").textContent=description.length+"/4000 caracteres";
 }
 function availability(){
  const entry=h(),season=Number($("#udRecapSeason").value),episode=Number($("#udRecapEpisode").value);
  $("#udRecapRestoreHistorical").disabled=!entry||selected===null;
  if(entry)info("T"+season+"E"+episode+": se encontró un título y una descripción canónicos en el código histórico original. Podés recuperarlos sin reescribir lo que ya está en tu ficha. No es una comprobación de la última edición de YouTube.");
  else if(Number.isInteger(season)&&season>0&&Number.isInteger(episode)&&episode>0)info("T"+season+"E"+episode+": no hay título y descripción históricos comprobados. Usá la plantilla canónica y escribilos vos después de mirar el video. No se interpretará el prompt.");
  else info("Elegí un archivo, temporada y episodio. Opción 1: copy histórico cuando exista. Opción 2: plantilla canónica para redactar manualmente.");
  updateCounters();
 }
 function restoreHistorical(){
  const entry=h();if(!entry||selected===null)return;
  $("#udRecapTitle").value=entry.title;$("#udRecapDescription").value=entry.description;
  remember();updateCounters();
  info("✓ Copia canónica histórica recuperada para T"+entry.season+"E"+entry.episode+". Revisá la correspondencia con el video. No se guardó ni se publicó nada.");
 }
 function useManualTemplate(){
  if(selected===null){info("Primero seleccioná un video original.");return}
  const title=$("#udRecapTitle"),description=$("#udRecapDescription");
  if(!title.value.trim())title.value=FRUTTI_MANUAL_TITLE;
  if(!description.value.trim())description.value=FRUTTI_MANUAL_DESCRIPTION;
  remember();updateCounters();
  info("Editá todos los textos entre corchetes. El título lleva dos palabras iniciales EN MAYÚSCULAS, dos puntos y el acontecimiento real; máximo 100 caracteres incluidos los hashtags. La descripción explica lo que pasa y termina con los mismos hashtags. No se puede guardar una plantilla sin completar.");
 }
 function summary(){
  $("#udForensicSummary").textContent=files.length+" archivos originales · "+records.size+" fichas en el stock reconstruido · "+Math.max(0,files.length-records.size)+" pendientes.";
 }
 function selectFile(index,switchPane=true){
  if(selected!==null&&selected!==index)remember();
  const file=files.find(x=>x.file_index===index);if(!file)return;
  selected=index;
  const existing=records.get(index),data=drafts.get(index)||existing||{};
  $("#udRecapSelected").textContent="ARCHIVO "+String(index+1).padStart(2,"0")+" · SHA-256 "+file.sha256_short+"…"+(existing?" · guardado, revisión "+existing.revision:" · pendiente");
  for(const id of fields){const key={udRecapSeason:"season",udRecapEpisode:"episode",udRecapPrompt:"generation_prompt",udRecapTitle:"title",udRecapDescription:"description",udRecapNote:"note"}[id];$("#"+id).value=data[key]??"";}
  $("#udRecapStatus").textContent=existing?"Esta ficha ya está guardada. Editarla no publica el video.":"Identificá el episodio mirando el video y completá su ficha.";
  availability();render();
  if(switchPane&&window.matchMedia("(max-width:900px)").matches){
   $("#udRecoveryPanels").classList.add("ud-show-prompts");
   $("#udShowVideos").classList.remove("ud-active");
   $("#udShowPrompts").classList.add("ud-active");
   $("#udRecoveryPane").scrollIntoView({block:"start",behavior:"smooth"});
  }
 }
 function renderStock(){
  const root=$("#udRecapStockList");root.replaceChildren();
  if(!records.size){root.append(udText("p","udmuted","No hay nuevas fichas guardadas. Los videos originales permanecen intactos."));return}
  for(const v of [...records.values()].sort((a,b)=>a.season-b.season||a.episode-b.episode)){
   const btn=udText("button","ud-recap-record","T"+v.season+" · E"+String(v.episode).padStart(2,"0")+" · "+v.title);
   btn.type="button";
   btn.append(udText("small","","Archivo "+String(v.file_index+1).padStart(2,"0")+" · revisión "+v.revision+" · no publicado"));
   btn.onclick=()=>selectFile(v.file_index);root.append(btn);
  }
 }
 function render(){
  const root=$("#udForensicItems");root.replaceChildren();
  const filter=$("#udForensicFilter").value,needle=$("#udForensicSearch").value.toLowerCase().trim();
  const shown=files.filter(f=>{
   const record=records.get(f.file_index);
   return (filter==="all"||(filter==="assigned"&&record)||(filter==="pending"&&!record))&&(!needle||[f.file_index+1,f.transcript_raw,record?.title].join(" ").toLowerCase().includes(needle));
  });
  if(!shown.length){root.append(udText("p","udmuted","Sin videos para estos filtros."));return}
  for(const f of shown){
   const card=udText("article","ud-forensic-item"),saved=records.get(f.file_index);
   if(f.contact_image_url){const img=document.createElement("img");img.src=f.contact_image_url;img.loading="lazy";img.alt="Fotogramas del archivo "+(f.file_index+1);card.append(img)}
   const body=udText("div","ud-forensic-item-body");
   body.append(udText("strong","","ARCHIVO "+String(f.file_index+1).padStart(2,"0")));
   body.append(udText("span","ud-forensic-tag",saved?"T"+saved.season+" E"+saved.episode+" · GUARDADO":"SIN IDENTIFICAR"));
   if(f.video_url){
    const play=udText("button","ud-small-button","▶ REPRODUCIR VIDEO ORIGINAL");play.type="button";
    play.onclick=()=>{
     const old=card.querySelector("video");
     if(old){old.remove();play.textContent="▶ REPRODUCIR VIDEO ORIGINAL";return}
     for(const video of document.querySelectorAll("#udForensicItems video"))video.pause();
     const video=document.createElement("video");video.controls=true;video.playsInline=true;video.preload="none";video.src=f.video_url;video.setAttribute("aria-label","Archivo "+(f.file_index+1));play.after(video);play.textContent="OCULTAR VIDEO";
    };body.append(play);
   }else body.append(udText("small","udmuted","El video no está disponible temporalmente. Actualizá el panel."));
   body.append(udText("div","ud-forensic-speech","DIÁLOGO: “"+(f.transcript_raw||"Sin texto detectado")+"”"));
   body.append(udText("small","udmuted","SHA-256 "+f.sha256_short+"… · MP4 original sin cambios"));
   const button=udText("button","ud-recap-select"+(selected===f.file_index?" ud-active":""),saved?"ABRIR FICHA GUARDADA":"IDENTIFICAR ESTE VIDEO");
   button.type="button";button.onclick=()=>selectFile(f.file_index);body.append(button);card.append(body);root.append(card);
  }
 }
 async function load(input){
  files=input||[];
  const response=await request("GET");
  records=new Map((response.items||[]).map(v=>[v.file_index,v]));
  historical=new Map((response.historical_metadata||[]).map(v=>[historicalKey(v.season,v.episode),v]));
  summary();render();renderStock();
  $("#udForensicStatus").textContent="Elegí el MP4 y completá manualmente su identidad. Solo hay dos opciones editoriales: recuperar metadatos canónicos históricos reales cuando existan, o escribir título y descripción con la plantilla. No hay interpretación automática del prompt.";
  $("#udRecapStatus").textContent="Este stock temporal no publica, aprueba ni programa videos.";
  if(selected!==null)selectFile(selected,false);else availability();
  $("#udForensicFilter").onchange=render;$("#udForensicSearch").oninput=render;
 }
 async function save(){
  const f=files.find(x=>x.file_index===selected);if(!f){$("#udRecapStatus").textContent="Seleccioná un archivo original.";return}
  const v=values(),season=Number(v.season),episode=Number(v.episode);
  if(![2,3].includes(season)||!Number.isInteger(episode)||episode<1||episode>25){$("#udRecapStatus").textContent="Elegí temporada 2 o 3 y un número de episodio entre 1 y 25.";return}
  if(v.generation_prompt.trim().length<20){$("#udRecapStatus").textContent="Pegá el prompt REAL y completo usado en Google Flow (no el plan de Prompt Studio).";return}
  if(!v.title.trim()||!v.description.trim()||synopsisNotAllowed.test(v.title+" "+v.description)){$("#udRecapStatus").textContent="Completá el título y la descripción con el hecho real. No se puede guardar el texto de ejemplo ni una plantilla sin completar.";return}
  const conflict=[...records.values()].find(x=>x.file_index!==selected&&x.season===season&&x.episode===episode);
  if(conflict){$("#udRecapStatus").textContent="T"+season+"E"+episode+" ya corresponde al archivo "+(conflict.file_index+1)+". Confirmá cuál es el video correcto.";return}
  remember();const btn=$("#udRecapSave");btn.disabled=true;btn.textContent="GUARDANDO…";
  try{
   const old=records.get(selected);
   const answer=await request("POST",{action:"save",file_index:selected,source_sha256:f.source_sha256,season,episode,generation_prompt:v.generation_prompt,title:v.title,description:v.description,note:v.note,expected_revision:old?.revision??null,
    episode_story_evidence:old?.episode_story_evidence||"",episode_story_extraction_method:old?.episode_story_extraction_method||""});
   if(!answer.saved)throw Error("El servidor no confirmó el guardado.");
   drafts.delete(selected);
   await load(files);
   $("#udRecapStatus").textContent="✓ GUARDADO T"+season+"E"+episode+" · archivo "+(selected+1)+". Stock reconstruido actualizado; MP4, YouTube y cola de publicación intactos.";
  }catch(e){$("#udRecapStatus").textContent="NO SE GUARDÓ: "+String(e?.message||e)}
  finally{btn.disabled=false;btn.textContent="GUARDAR EN STOCK RECONSTRUIDO";}
 }
 for(const id of fields)$("#"+id).addEventListener("input",()=>{remember();if(id==="udRecapTitle"||id==="udRecapDescription")updateCounters()});
 for(const id of ["udRecapSeason","udRecapEpisode"]){$("#"+id).addEventListener("input",availability);$("#"+id).addEventListener("change",availability)}
 $("#udRecapRestoreHistorical").onclick=restoreHistorical;
 $("#udRecapTemplate").onclick=useManualTemplate;
 $("#udRecapSave").onclick=save;
 return{load,render};
}
