// FruttiDrama: human-written or historically recovered YouTube metadata ONLY.
// No prompt, story, previous beat, semantic model, or episode-number inference.
export const FRUTTI_CANONICAL_TAGS="#Shorts #ViralShorts #FruttiDrama";
export const FRUTTI_TITLE_TEMPLATE="GANCHO CENTRAL: [describí el hecho] "+FRUTTI_CANONICAL_TAGS;
export const FRUTTI_DESCRIPTION_TEMPLATE="[Contá qué sucede en el video y a quién afecta.]\n\n"+FRUTTI_CANONICAL_TAGS;
const HOOK_RE=/^([A-ZÁÉÍÓÚÜÑ0-9]+) ([A-ZÁÉÍÓÚÜÑ0-9]+):\s+([^\n]+)$/u;
export function checkFruttiMetadata(title,description,{historicalExact=false}={}){
 const t=String(title||"").replace(/\s+/g," ").trim();
 const d=String(description||"").trim();
 if(t.length<12||t.length>100)return {ok:false,error:"TITLE_LENGTH_INVALID"};
 if(d.length<12||d.length>4000)return {ok:false,error:"DESCRIPTION_LENGTH_INVALID"};
 if(!historicalExact){
  if(!HOOK_RE.test(t)||/…|\.\.\./.test(t))return {ok:false,error:"TITLE_FORMAT_INVALID"};
  if(!t.endsWith(" "+FRUTTI_CANONICAL_TAGS)||!d.endsWith(FRUTTI_CANONICAL_TAGS))return {ok:false,error:"CANONICAL_HASHTAGS_MISSING"};
 }
 if(/\[[^\]]+\]/.test(t+" "+d)||/\b(?:GANCHO CENTRAL|DESCRIBÍ EL HECHO|CONTÁ QUÉ SUCEDE)\b/i.test(t+" "+d))return {ok:false,error:"UNEDITED_CANONICAL_TEMPLATE"};
 if(/\b(?:one continuous scene|unbroken take|cinematic shot|camera movement|character reference sheets|9:16 vertical|no duplicates|ambient audio)\b/i.test(d))return {ok:false,error:"COPY_NOT_NARRATIVE"};
 return {ok:true,title:t,description:d};
}
