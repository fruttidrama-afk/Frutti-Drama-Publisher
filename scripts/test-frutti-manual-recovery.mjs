import assert from "node:assert/strict";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {buildFruttiSourceCopy,selectFruttiSourceIdea,FRUTTI_TITLE_TAGS} from "../frutti-creative-package.js";
import {checkFruttiMetadata,FRUTTI_CANONICAL_TAGS,FRUTTI_TITLE_TEMPLATE,FRUTTI_DESCRIPTION_TEMPLATE} from "../supabase/functions/publisher-frutti-recap/metadata-contract.js";
import {LEGACY_FRUTTI_METADATA} from "../supabase/functions/publisher-frutti-recap/legacy-metadata.js";
import {initFruttiRecap,FRUTTI_MANUAL_TITLE,FRUTTI_MANUAL_DESCRIPTION} from "../docs/frutti-recap.js";

let checks=0;
const check=(x,msg)=>{assert.ok(x,msg);checks++};
const same=(x,y,msg)=>{assert.deepEqual(x,y,msg);checks++};
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const api=read("supabase/functions/publisher-frutti-recap/index.ts");
const html=read("docs/index.html"),html2=read("factory-web/public/index.html");
const ui=read("docs/frutti-recap.js"),ui2=read("factory-web/public/frutti-recap.js");
const runtime=read("runtime-config.js"),init=read("runtime-init.js"),provider=read("free-browser-provider.js"),server=read("server.js"),publication=read("publication.js");

check(!api.includes('import {generateFruttiRecapCopy}'),"No import of failed narrative engine");
check(!api.includes('FRUTTI_S3_STORY_METADATA'),"No unverified T3 proposal presented as historical copy");
check(api.includes('NARRATIVE_EXTRACTOR_RETIRED'),"Suggest must return 410 Gone");
check(api.includes('historical_metadata:LEGACY_FRUTTI_METADATA'),"Only canonical historical metadata offered");
check(api.indexOf("const owner=")<api.indexOf('historical_metadata:LEGACY_FRUTTI_METADATA'),"Metadata requires authenticated owner");
check(api.includes("checkFruttiMetadata("),"Backend verifies manual formats");
check(api.includes('metadata_method:exactLegacy?"legacy_canonical_operator_reviewed":"operator_manual_copy"'),"Provenance distinguishes human from original");
check(api.includes('publication_queue_unchanged:true'),"Publication queue unchanged");
same(LEGACY_FRUTTI_METADATA.length,12,"Only 12 source-backed T2 pairs");
check(LEGACY_FRUTTI_METADATA.every(x=>x.season===2&&x.episode>=2&&x.episode<=13),"No invented T3 historical metadata");
check(LEGACY_FRUTTI_METADATA.find(x=>x.episode===9).title.startsWith("CRIADA ATREVIDA:"),"T2E9 from source, not extractor");
check(LEGACY_FRUTTI_METADATA.find(x=>x.episode===12).title.startsWith("MUERTE DE BANANA:"),"Historical exception preserved");
same(FRUTTI_CANONICAL_TAGS,FRUTTI_TITLE_TAGS,"Editor and generator follow the same hashtag contract");
same(FRUTTI_TITLE_TEMPLATE,FRUTTI_MANUAL_TITLE,"Same title scaffold on client and backend");
same(FRUTTI_DESCRIPTION_TEMPLATE,FRUTTI_MANUAL_DESCRIPTION,"Same description scaffold on client and backend");
check(!checkFruttiMetadata(FRUTTI_TITLE_TEMPLATE,FRUTTI_DESCRIPTION_TEMPLATE).ok,"Scaffold must not be savable");
const copyTitle="SECRETO REVELADO: Fresia encuentra una carta "+FRUTTI_TITLE_TAGS;
const copyDesc="Fresia encuentra una carta mientras Uva se acerca al escritorio.\n\n"+FRUTTI_TITLE_TAGS;
check(checkFruttiMetadata(copyTitle,copyDesc).ok,"Hand authored copy accepted");
for(const [title,description,label]of [
 [copyTitle.replace("SECRETO REVELADO","SECRETO DE FRESIA"),copyDesc,"3-word hook"],
 [copyTitle.replace(" "+FRUTTI_TITLE_TAGS,""),copyDesc,"missing title tags"],
 [copyTitle,copyDesc.replace(FRUTTI_TITLE_TAGS,""),"missing description tags"],
 [copyTitle.replace("carta","carta…"),copyDesc,"truncated title"],
 [FRUTTI_TITLE_TEMPLATE,copyDesc,"title scaffold"],
 [copyTitle,FRUTTI_DESCRIPTION_TEMPLATE,"description scaffold"],
 ["SECRETO REVELADO: "+"x".repeat(90)+" "+FRUTTI_TITLE_TAGS,copyDesc,"overlong title"],
 [copyTitle,"one continuous scene and no duplicates "+FRUTTI_TITLE_TAGS,"technical caption"]
])check(!checkFruttiMetadata(title,description).ok,"Must reject "+label);
check(checkFruttiMetadata(LEGACY_FRUTTI_METADATA.find(x=>x.episode===12).title,LEGACY_FRUTTI_METADATA.find(x=>x.episode===12).description,{historicalExact:true}).ok,"Legacy hook kept only when exact");

const idea={
 hook:"SECRETO REVELADO",story:"Fresia encuentra una carta que Don Melón guardó en secreto en su oficina.",
 titleCore:"Fresia encuentra una carta escondida",
 descriptionCore:"Fresia encuentra una carta escondida en la oficina. La lleva consigo antes de que Don Melón regrese."
};
const produced=buildFruttiSourceCopy(idea);
same(produced.title,"SECRETO REVELADO: Fresia encuentra una carta escondida "+FRUTTI_TITLE_TAGS,"Creative package title comes from authored titleCore");
same(produced.description,idea.descriptionCore+"\n\n"+FRUTTI_TITLE_TAGS,"Creative package caption comes from authored descriptionCore");
same(selectFruttiSourceIdea({hook:idea.hook,story:idea.story},idea).description,produced.description,"Exact source idea required");
for(const changes of [
 {...idea,titleCore:""},
 {...idea,descriptionCore:""},
 {...idea,hook:"SECRETO DE FRESIA"},
 {...idea,titleCore:"Esta oración hace que el título exceda el máximo de cien caracteres permitidos al agregar todos los hashtags"},
 {...idea,descriptionCore:"Use character reference sheets and no duplicates."}
]){
 let blocked=false;try{buildFruttiSourceCopy(changes)}catch{blocked=true}check(blocked,"Incomplete source idea must block before Flow");
}
let sourceMismatch=false;try{selectFruttiSourceIdea({hook:idea.hook,story:"A different episode."},idea)}catch{sourceMismatch=true}
check(sourceMismatch,"Changed episode intent cannot reuse old editorial copy");
for(let i=0;i<20;i++){
 const sample={...idea,titleCore:"Fresia encuentra una carta número "+i,descriptionCore:idea.descriptionCore+" Número de capítulo "+i+"."};
 const out=buildFruttiSourceCopy(sample);
 check(out.title.length<=100&&out.description.endsWith(FRUTTI_TITLE_TAGS),"Source editorial package "+i);
}

check(runtime.includes('selectFruttiSourceIdea(row,ideaForEpisode(Number(row.episode)))'),"Runtime uses full upstream episode idea, not prompt parser");
check(runtime.includes('db.exec("BEGIN IMMEDIATE")')&&runtime.includes('db.exec("COMMIT")')&&runtime.includes('db.exec("ROLLBACK")'),"Creative package and ledger atomic transaction");
check(runtime.includes("INSERT INTO factory_creative_packages("),"Archive captures complete source package");
check(runtime.includes("FRUTTI_SOURCE_IDEA_NOT_MATCHED")===false,"Only source-contract module owns exact-intent error");
check(provider.includes("FRUTTI_COPY_MUST_ORIGINATE_WITH_EPISODE_SOURCE"),"Provider disallows fallback title generator");
check(provider.includes("FRUTTI_METADATA_REPAIR_FORBIDDEN"),"Review cannot reconstruct failed source copy");
check(server.includes("FRUTTI_CREATIVE_PACKAGE_LEDGER_REQUIRED"),"Review approval cannot invent missing copy");
check(publication.includes("FRUTTI_CREATIVE_PACKAGE_ARCHIVE_REQUIRED"),"Publishing requires archived copy, not Flow inference");
check(init.includes("factory_creative_packages_no_update")&&init.includes("factory_creative_packages_no_delete"),"Ledger append-only enforced");

const schemaBlock=init.match(/CREATE TABLE IF NOT EXISTS factory_creative_packages\([\s\S]*?(?=CREATE TABLE IF NOT EXISTS factory_meta)/)?.[0];
check(Boolean(schemaBlock),"Complete SQLite ledger schema present");
const database=new DatabaseSync(":memory:");
database.exec(schemaBlock);
database.prepare("INSERT INTO factory_creative_packages(packageId,itemId,season,episode,hook,story,prompt,title,description,promptHash,packageHash,packageSchema,sourceMethod,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
.run("pkg-1","item-1",3,13,idea.hook,idea.story,"FLOW PROMPT",produced.title,produced.description,"prompt-hash","package-hash","v1","episode_source_authored",new Date().toISOString());
same(database.prepare("SELECT title,description FROM factory_creative_packages WHERE packageId='pkg-1'").get(),{title:produced.title,description:produced.description},"Stored package roundtrips");
let updateBlocked=false,deleteBlocked=false;
try{database.exec("UPDATE factory_creative_packages SET title='altered' WHERE packageId='pkg-1'")}catch{updateBlocked=true}
try{database.exec("DELETE FROM factory_creative_packages WHERE packageId='pkg-1'")}catch{deleteBlocked=true}
check(updateBlocked&&deleteBlocked,"Post-hoc package edits and deletion rejected");
database.close();

same(ui,ui2,"Both published frontends share exactly the same manual UI code");
for(const h of [html,html2]){
 for(const marker of ["udRecapRestoreHistorical","udRecapTemplate","udRecapTitleCounter","udRecapDescriptionCounter","udRecapPrompt","udRecapSave"])
  check(h.includes('id="'+marker+'"'),"HTML field "+marker+" exists");
 for(const obsolete of ["udRecapSuggest","udRecapOperatorStory","GENERAR PROPUESTA DESDE PROMPT","Cargando generador editorial local"])
  check(!h.includes(obsolete),"No obsolete extractor controls "+obsolete);
 check(h.includes("frutti-recap.js?v=20261110-manual-recap-v1"),"iPad cache-busting");
}
check(!ui.includes('action:"suggest"')&&!ui.includes("episode_excerpt")&&!ui.includes("story_action_v"),"No client narrative AI call");

class Element{
 constructor(tag){this.tag=tag;this.id="";this.value="";this.textContent="";this.disabled=false;this.hidden=false;this.dataset={};this.children=[];this.handlers={};this.classList={add(){},remove(){}}}
 append(...children){this.children.push(...children)}
 before(...x){}
 after(...x){}
 replaceChildren(){this.children=[]}
 addEventListener(type,fn){(this.handlers[type]||=[]).push(fn)}
 fire(type){for(const fn of this.handlers[type]||[])fn()}
 scrollIntoView(){}
 querySelector(){return null}
}
const elements=new Map(),built=[];
function $(id){const dynamic=built.find(x=>"#"+x.id===id);if(dynamic)return dynamic;if(!elements.has(id))elements.set(id,new Element("mock"));return elements.get(id)}
globalThis.document={querySelector:$,createElement:tag=>{const e=new Element(tag);built.push(e);return e},querySelectorAll:()=>[]};
globalThis.window={matchMedia:()=>({matches:false})};
$("#udForensicFilter").value="all";
let requests=[],remoteItems=[];
globalThis.fetch=async(url,options)=>{
 const body=options?.body?JSON.parse(options.body):null;
 requests.push({method:options.method,body});
 if(body?.action==="save"){
  const v={...body,revision:1};
  remoteItems.push(v);
  return{ok:true,json:async()=>({saved:true,record:v})};
 }
 return{ok:true,json:async()=>({items:remoteItems,historical_metadata:LEGACY_FRUTTI_METADATA,metadata_modes:["historical","manual"]})};
};
const app=initFruttiRecap({session:async()=>({access_token:"mock-owner"}),udText:(tag,cls,label)=>{const e=new Element(tag);e.textContent=label||"";built.push(e);return e}});
const files=[{file_index:0,sha256_short:"abc",source_sha256:"a".repeat(64),transcript_raw:"Fresia entra al jardín",video_url:null}];
await app.load(files);
const choose=built.find(x=>x.textContent==="IDENTIFICAR ESTE VIDEO");
check(Boolean(choose?.onclick),"Manual video selector present");
choose.onclick();
$("#udRecapSeason").value="2";$("#udRecapSeason").fire("input");
$("#udRecapEpisode").value="9";$("#udRecapEpisode").fire("input");
same($("#udRecapTitle").value,"","Never fill copy from inferred episode number alone");
check(!$("#udRecapRestoreHistorical").disabled,"T2 historical button enabled");
$("#udRecapRestoreHistorical").onclick();
same($("#udRecapTitle").value,LEGACY_FRUTTI_METADATA.find(x=>x.episode===9).title,"Historical button restores original");
$("#udRecapTitle").value="Manual operator override";
$("#udRecapTemplate").onclick();
same($("#udRecapTitle").value,"Manual operator override","Template cannot overwrite prior edits");
$("#udRecapTitle").value="";$("#udRecapDescription").value="";
$("#udRecapTemplate").onclick();
same($("#udRecapTitle").value,FRUTTI_TITLE_TEMPLATE,"Manual title template filled");
same($("#udRecapDescription").value,FRUTTI_DESCRIPTION_TEMPLATE,"Manual description template filled");
$("#udRecapPrompt").value="Real Flow generation prompt containing scene directions and exact referenced characters.";
$("#udRecapSave").onclick();
same(requests.filter(x=>x.method==="POST").length,0,"Incomplete template must not be saved");
$("#udRecapTitle").value=copyTitle;$("#udRecapDescription").value=copyDesc;
await $("#udRecapSave").onclick();
same(requests.filter(x=>x.method==="POST").length,1,"One operator-written save only");
same(requests.filter(x=>x.body?.action==="suggest").length,0,"Never call failed AI endpoint");
same(remoteItems.length,1,"Exactly one operator-authorized stock record");
console.log("PASS Frutti human recovery contract, original metadata, source creative packages and immutable ledger: "+checks+" checks; zero Flow/YouTube calls.");
