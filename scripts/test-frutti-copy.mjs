import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

const src=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
assert(src.includes("const answer=await realAICopy(prompt)"),"suggest route must invoke real model inference");
assert(!src.includes("return json(draftFromPrompt(prompt))"),"rules engine must NOT serve suggestions");
const start=src.indexOf("async function realAICopy("),end=src.indexOf("\nDeno.serve(",start);
assert(start>0&&end>start,"real model implementation must exist");
const fn=stripTypeScriptTypes(src.slice(start,end))+"\n({realAICopy})";
const modelResult={
 identified:true,
 title:"FRESIA CONTRAATACA: Fresia enfrenta a Uva por Limón",
 description:"Fresia le recuerda a Uva que Limón seguirá unido a ella por su hijo. Uva responde que no competirá por su amor. ¿Podrá Fresia sembrar nuevas dudas entre los dos?",
 specific_event:"Fresia enfrenta a Uva por el vínculo de Limón con su hijo.",
 uncertainty:""
};
let calls=0;
const state={key:"fixture-secret",response:modelResult,fail:false};
const ctx={
 Deno:{env:{get:(k)=>k==="GEMINI_API_KEY"?state.key:""}},
 AbortSignal,
 fetch:async(url,req)=>{
  calls++;
  assert(url.includes("generativelanguage.googleapis.com"),"must hit genuine model provider");
  const parsed=JSON.parse(req.body);
  assert(parsed.contents[0].parts[0].text.includes("Fresia confronta a Uva"),"model must see episode prompt");
  if(state.fail)return {ok:false,status:429};
  return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(state.response)}]}}]})};
 }
};
const {realAICopy}=vm.runInNewContext(fn,ctx);
const prompt="EPISODE\nFRESIA CONTRAATACA: Fresia confronta a Uva. Uva tells her she refuses to compete for Limón.";
let out=await realAICopy(prompt);
assert.equal(out.method,"generative_ai");
assert(out.title.includes("Fresia enfrenta a Uva"));
assert(out.title.length<=100);
assert(out.description.includes("Uva responde"));
assert(out.description.includes("#FruttiDrama"));
assert.equal(calls,1);
state.key="";
out=await realAICopy(prompt);
assert.equal(out.error,"AI_NOT_CONFIGURED","no silent generic fallback when AI key missing");
assert.equal(calls,1);
state.key="fixture-secret";state.fail=true;
out=await realAICopy(prompt);
assert.equal(out.error,"AI_HTTP_429","rate limits must not be confused with story analysis");
state.fail=false;state.response={identified:false,title:"",description:"",specific_event:"",uncertainty:"No hay trama del episodio"};
out=await realAICopy(prompt);
assert.equal(out.error,"AI_STORY_UNKNOWN","unclear story must fail closed");
console.log("PASS FruttiDrama: genuine AI HTTP request, story grounded copy, no-key error, rate limit and low-confidence gates");
