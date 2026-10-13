import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

const source=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
assert(source.includes("const answer=await realAICopy(prompt)"),"generation must use model endpoint");
assert(!source.includes("GEMINI_API_KEY")&&!source.includes("OPENAI_API_KEY")&&!source.includes("api.openai.com"),"no billed AI routes");
assert(source.includes("OPENROUTER_API_KEY")&&source.includes("isZeroPrice"),"free-only guardrails missing");
const start=source.indexOf("const FREE_MODEL_IDS="),end=source.indexOf("\nDeno.serve(",start);
assert(start>=0&&end>start,"source section missing");
const executable=stripTypeScriptTypes(source.slice(start,end))+"\n({realAICopy})";
const story={
 identified:true,
 title:"FRESIA CONTRAATACA: Fresia enfrenta a Uva por Limón",
 description:"Fresia enfrenta a Uva y le recuerda que Limón seguirá unido a ella por su hijo. Uva rechaza competir por su amor y exige sinceridad. ¿Conseguirá Fresia dividir a la pareja?",
 specific_event:"Fresia enfrenta a Uva por los sentimientos hacia Limón.",
 uncertainty:""
};
let attempts=[];
const state={key:"free-test-key",price:"0",catalogHTTP:200,completionHTTP:200,payload:story};
const catalog=(price)=>({data:[{id:"deepseek/deepseek-v4-flash-0731:free",pricing:{prompt:price,completion:price,request:"0"}}]});
const ctx={
 Deno:{env:{get:(k)=>k==="OPENROUTER_API_KEY"?state.key:""}},
 AbortSignal,
 fetch:async(url,opts={})=>{
  attempts.push(String(url));
  if(String(url).endsWith("/models")){
   return {ok:state.catalogHTTP===200,status:state.catalogHTTP,json:async()=>catalog(state.price)};
  }
  assert(String(url).endsWith("/chat/completions"),"must call only free verified model API");
  const request=JSON.parse(opts.body);
  assert(request.model.endsWith(":free"),"must only call explicitly free variant");
  assert.equal(request.provider.allow_fallbacks,false,"no fallback to potentially billed models");
  assert(request.messages[1].content.includes("Fresia confronta a Uva"),"full prompt missing");
  return {ok:state.completionHTTP===200,status:state.completionHTTP,json:async()=>({choices:[{message:{content:JSON.stringify(state.payload)}}]})};
 }
};
const {realAICopy}=vm.runInNewContext(executable,ctx);
const prompt="EPISODE\nFRESIA CONTRAATACA: Fresia confronta a Uva about her relationship with Limón.";
let result=await realAICopy(prompt);
assert.equal(result.method,"free_chinese_llm");
assert(result.title.startsWith("FRESIA CONTRAATACA:"));
assert(result.description.includes("Fresia enfrenta a Uva"));
assert(result.description.includes("#FruttiDrama"));
assert.deepEqual(attempts.length,2,"must verify live prices before generating");

state.key="";attempts=[];
result=await realAICopy(prompt);
assert.equal(result.error,"FREE_AI_NOT_CONFIGURED");
assert.equal(attempts.length,0,"unconfigured provider should not call external API");

state.key="free-test-key";state.price="0.0001";attempts=[];
result=await realAICopy(prompt);
assert.equal(result.error,"NO_VERIFIED_FREE_MODEL");
assert.equal(attempts.length,1,"nonzero pricing must forbid completion calls");

state.price="0";state.completionHTTP=429;attempts=[];
result=await realAICopy(prompt);
assert.equal(result.error,"FREE_AI_HTTP_429");
assert.equal(attempts.length,2,"rate limit must never trigger paid fallback");

state.completionHTTP=200;state.payload={identified:false,uncertainty:"No hay trama del episodio."};attempts=[];
result=await realAICopy(prompt);
assert.equal(result.error,"FREE_AI_STORY_UNKNOWN");

console.log("PASS free model only, live price verification, no key, no charge, 429 no fallback, narrative validity");
