import assert from "node:assert/strict";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {buildFruttiSourceCopy,selectFruttiSourceIdea,FRUTTI_TITLE_TAGS} from "../frutti-creative-package.js";
import {createFruttiShowrunnerInstruction,validateFruttiShowrunnerOutput} from "../frutti-autonomous-source.js";
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
check(api.includes('historical_prompt_not_yet_available'),"Missing source Flow prompt is never invented");

const migratedConstraints=read("supabase/migrations/20261111_frutti_recap_manual_stock_constraints.sql");
for(const allowedMethod of ["operator_reviewed","ai_draft_reviewed","rules_draft_reviewed",
 "legacy_canonical_operator_reviewed","operator_manual_copy"]){
 check(migratedConstraints.includes("'"+allowedMethod+"'"),"Migration permits original or manual metadata method "+allowedMethod);
}
for(const provenance of ["operator_copied_google_flow","historical_prompt_not_yet_available"]){
 check(migratedConstraints.includes("'"+provenance+"'"),"Migration permits actual Flow prompt provenance "+provenance);
}
check(migratedConstraints.includes("generation_prompt = '' AND prompt_provenance = 'historical_prompt_not_yet_available'"),"DB allows optional Flow prompt without placeholder content");
check(migratedConstraints.includes("char_length(generation_prompt) BETWEEN 20 AND 50000"),"DB rejects partial or oversized Flow prompts");
check(migratedConstraints.includes("publisher_frutti_reconstructed_stock_metadata_method_check"),"DB migration updates method constraint");
check(migratedConstraints.includes("publisher_frutti_reconstructed_stock_prompt_provenance_check"),"DB migration updates provenance constraint");
check(migratedConstraints.includes("publisher_frutti_reconstructed_stock_generation_prompt_check"),"DB migration updates prompt constraint");
check(api.includes('metadata_method:exactLegacy?"legacy_canonical_operator_reviewed":"operator_manual_copy"'),"API methods match persisted DB");
check(api.includes('prompt?"operator_copied_google_flow":"historical_prompt_not_yet_available"'),"API provenance matches persisted DB");
check(api.includes('code==="23514"')&&api.includes("RECONSTRUCTED_STOCK_SCHEMA_MISMATCH"),"DB check violation must not be hidden behind generic error");
check(api.includes('console.error("FRUTTI_RECAP_STOCK_WRITE_REJECTED"'),"DB save failure diagnostics must be available without exposing user copy");
check(!api.includes("JSON.stringify(saveError)")&&!api.includes("saveError.details"),"Never log original prompt, title, description via Postgres details");

check(api.includes('prompt.length>0&&prompt.length<20'),"Historical prompt optional, but partial copy rejected");
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

check(runtime.includes('selectFruttiSourceIdea(row,fruttiSource)')&&runtime.includes('ideaForEpisode(Number(row.episode))'),"Runtime uses complete source-authored idea or source-authored rewrite, never prompt parser");
check(runtime.includes('db.exec("BEGIN IMMEDIATE")')&&runtime.includes('db.exec("COMMIT")')&&runtime.includes('db.exec("ROLLBACK")'),"Creative package and ledger atomic transaction");
check(runtime.includes("INSERT INTO factory_creative_packages("),"Archive captures complete source package");
check(runtime.includes("FRUTTI_SOURCE_IDEA_NOT_MATCHED")===false,"Only source-contract module owns exact-intent error");
check(provider.includes("FRUTTI_COPY_MUST_ORIGINATE_WITH_EPISODE_SOURCE"),"Provider disallows fallback title generator");
check(provider.includes("FRUTTI_METADATA_REPAIR_FORBIDDEN"),"Review cannot reconstruct failed source copy");
check(provider.includes('row=await authorFruttiSourceEpisode(db,row);'),"Every fresh Frutti Flow preparation receives upstream source episode decision");
check(provider.indexOf('row=await authorFruttiSourceEpisode(db,row);')<provider.indexOf('const cp=preparePromptIfNeeded(db,row);',provider.indexOf('async function processRow(db,row)')),"Source creative author must run BEFORE prompt builder and Flow");
check(provider.includes("FRUTTI_SOURCE_REWRITE_AFTER_PROMPT_FORBIDDEN"),"Do not rewrite an existing prompt or media");
check(provider.includes("FRUTTI_SHOWRUNNER_CONCURRENT_SOURCE_CHANGE"),"Source writer preserves once-only atomic guard");
check(provider.includes('SELECT COUNT(*) AS n FROM factory_generations WHERE itemId=?'),"Historic render record blocks source story replacement");
check(provider.includes("function packageMatches(db,row)")&&provider.includes("packageMatches(db,fresh)")&&provider.includes("packageMatches(db,row)"),"Every Frutti creative archive check receives scoped SQLite");
check(!provider.includes("function packageMatches(row)"),"Removed bad undefined SQLite reference");
check(publication.includes("SELECT id,episode,hook,story,prompt,title,description,creativePackageHash,creativePackageId,flowResult FROM factory_items WHERE id=?"),"Reconciliation includes factory ID for immutable archive lookup");


check(provider.includes("FRUTTI_REWRITE_MUST_AUTHOR_FULL_CREATIVE_PACKAGE")&&provider.includes("new_publication_hook")&&provider.includes("new_title_core")&&provider.includes("new_description_core"),"Creative-rewrite AI must author all copy at the same time as new episode intent");
check(server.includes("FRUTTI_CREATIVE_PACKAGE_LEDGER_REQUIRED"),"Review approval cannot invent missing copy");
check(publication.includes("FRUTTI_CREATIVE_PACKAGE_ARCHIVE_REQUIRED"),"Publishing requires archived copy, not Flow inference");
check(init.includes("factory_creative_packages_no_update")&&init.includes("factory_creative_packages_no_delete"),"Ledger append-only enforced");

const schemaBlock=init.match(/CREATE TABLE IF NOT EXISTS factory_creative_packages\([\s\S]*?(?=CREATE TABLE IF NOT EXISTS factory_meta)/)?.[0];
check(Boolean(schemaBlock),"Complete SQLite ledger schema present");
const database=new DatabaseSync(":memory:");
database.exec(schemaBlock);
database.prepare("INSERT INTO factory_creative_packages(packageId,itemId,season,episode,hook,story,prompt,title,description,promptHash,packageHash,packageSchema,sourceMethod,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
.run("pkg-1","item-1",3,13,idea.hook,idea.story,"FLOW PROMPT",produced.title,produced.description,"prompt-hash","package-hash","v1","episode_source_authored",new Date().toISOString());
same({...database.prepare("SELECT title,description FROM factory_creative_packages WHERE packageId='pkg-1'").get()},{title:produced.title,description:produced.description},"Stored package roundtrips");
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
 check(h.includes("frutti-recap.js?v=20261110-manual-recap-v2"),"iPad cache-busting");
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
$("#udRecapPrompt").value=""; // Historic Flow prompt is unavailable; do not fabricate it.
$("#udRecapSave").onclick();
same(requests.filter(x=>x.method==="POST").length,0,"Incomplete template must not be saved");
$("#udRecapTitle").value=copyTitle;$("#udRecapDescription").value=copyDesc;
await $("#udRecapSave").onclick();
same(requests.filter(x=>x.method==="POST").length,1,"One operator-written save only");
same(requests.filter(x=>x.body?.action==="suggest").length,0,"Never call failed AI endpoint");
same(requests.find(x=>x.body?.action==="save").body.generation_prompt,"","Video identity may be saved with missing historical Flow prompt");
same(remoteItems.length,1,"Exactly one operator-authorized stock record");


const showrunnerRequest=createFruttiShowrunnerInstruction({
 season:3,episode:13,creativeBible:"Una telenovela de frutas humanoides, totalmente seria.",
 canon:"Uva cuida a Bananita. Banana murió. Limón está cerca de Uva.",
 previous:[{episode:12,hook:"ELECCIÓN DEFINITIVA",story:"Limón elige estar con Uva",status:"approved"}]
});
check(showrunnerRequest.includes("descriptionCore")&&showrunnerRequest.includes("titleCore")&&showrunnerRequest.includes("publicationHook"),"Source author requests copy alongside story");
check(!showrunnerRequest.includes("interpret the Flow prompt"),"Source author must never ask to interpret a finished Flow prompt");
const authored=validateFruttiShowrunnerOutput({
 hook:"TESTIGO SILENCIOSO",
 story:"Fresia descubre una carta escrita por Don Melón y decide ocultarla cuando Uva entra a la habitación.",
 publicationHook:"CARTA OCULTA",
 titleCore:"Fresia esconde una carta comprometedora",
 descriptionCore:"Fresia descubre una carta de Don Melón y decide ocultarla cuando escucha entrar a Uva."
},{season:3,episode:13,previous:[{episode:12,hook:"ELECCIÓN DEFINITIVA",story:"Limón elige estar con Uva"}]});
check(authored.title.startsWith("CARTA OCULTA:"),"Source author validates two-word publication title");
check(authored.description.endsWith(FRUTTI_TITLE_TAGS),"Source author validates complete original description");
check(authored.sourceMethod==="autonomous_episode_showrunner_v1","Source author explicitly stamps origin");
let priorRejected=false;try{validateFruttiShowrunnerOutput({
 hook:"TESTIGO SILENCIOSO",story:authored.story,publicationHook:authored.publicationHook,
 titleCore:authored.titleCore,descriptionCore:authored.descriptionCore
},{season:3,episode:14,existing:[{hook:authored.hook,story:authored.story}]})}catch{priorRejected=true}
check(priorRejected,"Repeat episode rejected before Flow");
let incompleteBlocked=false;try{validateFruttiShowrunnerOutput({
 hook:"NUEVA CARTA",story:"Fresia encuentra una carta pero decide no leerla hasta la noche.",
 publicationHook:"NUEVA CARTA",titleCore:"Fresia encuentra una carta"
},{season:3,episode:14})}catch{incompleteBlocked=true}
check(incompleteBlocked,"Source author cannot generate prompt with missing description");
check(!createFruttiShowrunnerInstruction({season:3,episode:13,creativeBible:"test",canon:"test"}).includes("story_action_v34"),"No retired narrative extractor in source author");

// Real SQLite integration of the SAME source-stage function used by the Flow
// runtime. This proves a future generation consumes a single package and
// inserts one append-only ledger row in the same transaction as factory_items.
const originalEnv={DATA_DIR:process.env.DATA_DIR,PUBLISHER_CONFIG_JSON:process.env.PUBLISHER_CONFIG_JSON};
const testRoot=fs.mkdtempSync("/tmp/frutti-creative-package-");
try{
 process.env.DATA_DIR=testRoot;
 process.env.PUBLISHER_CONFIG_JSON=JSON.stringify({
  identity:{show_name:"FruttiDrama",publisher_name:"FruttiDrama",language:"es-419"},
  content:{active_season:3,serialized:true,creative_bible:"FruttiDrama es una telenovela seriamente melodramática de frutas humanoides.",initial_episodes:[idea]},
  generation:{duration_seconds:10,aspect_ratio:"9:16",output_count:1}
 });
 const rt=await import("../runtime-config.js?frutti-package-integration=1");
 const db=new DatabaseSync(":memory:");
 const ddl=init.slice(init.indexOf("CREATE TABLE IF NOT EXISTS factory_items("),init.indexOf("CREATE TABLE IF NOT EXISTS factory_meta("));
 db.exec(ddl);
 const timestamp=new Date().toISOString();
 db.prepare("INSERT INTO factory_items(id,season,episode,hook,story,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)")
  .run("source-episode-1",3,1,idea.hook,idea.story,"draft",timestamp,timestamp);
 const original=db.prepare("SELECT * FROM factory_items WHERE id='source-episode-1'").get();
 const built=rt.materializeCreativePackage(db,original);
 same(built.row.title,produced.title,"Integrated prompt/creative headline written together");
 same(built.row.description,produced.description,"Integrated prompt/creative caption written together");
 check(built.row.prompt.includes("EPISODE INTENT: "+idea.story),"Prompt uses same editorial story");
 same(db.prepare("SELECT COUNT(*) as count FROM factory_creative_packages").get().count,1,"Exactly one package snapshot");
 const snapshot=db.prepare("SELECT prompt,title,description,hook,story,packageHash FROM factory_creative_packages WHERE packageId=?").get(built.row.creativePackageId);
 same(snapshot.prompt,built.row.prompt,"Original prompt archived with copy");
 same(snapshot.title,built.row.title,"Original title archived with prompt");
 same(snapshot.description,built.row.description,"Original caption archived with prompt");
 same(snapshot.packageHash,built.row.creativePackageHash,"Shared package hash bound to runtime item");
 const again=rt.materializeCreativePackage(db,built.row);
 check(!again.created,"Existing package with immutable archive must never regenerate metadata");
 same(db.prepare("SELECT COUNT(*) as count FROM factory_creative_packages").get().count,1,"Idempotent read causes no additional snapshot");
 db.close();
}finally{
 if(originalEnv.DATA_DIR===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=originalEnv.DATA_DIR;
 if(originalEnv.PUBLISHER_CONFIG_JSON===undefined)delete process.env.PUBLISHER_CONFIG_JSON;else process.env.PUBLISHER_CONFIG_JSON=originalEnv.PUBLISHER_CONFIG_JSON;
 fs.rmSync(testRoot,{recursive:true,force:true});
}

console.log("PASS Frutti human recovery contract, original metadata, source creative packages and immutable ledger: "+checks+" checks; zero Flow/YouTube calls.");
