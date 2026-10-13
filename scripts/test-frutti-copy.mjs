import assert from "node:assert/strict";
import fs from "node:fs";
const edge=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
const script=fs.readFileSync("supabase/functions/publisher-frutti-recap/frutti-recap-copy.js","utf8");
assert(edge.includes('generateFruttiRecapCopy(prompt)'),"recap must use local narrative package");
assert(!/OPENROUTER_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY|realAICopy/.test(edge+script),"recap must never need external AI keys");
const mod=await import("data:text/javascript;base64,"+Buffer.from(script).toString("base64"));
const generate=mod.generateFruttiRecapCopy;
const technical="FRUTTIDRAMA. Generate exactly one video. 9:16 one continuous unbroken take. CAMERA: dramatic close-up. Audio ambiance and fixed character reference sheets.";
const cases=[
 ["argument",
  "FRUTTIDRAMA S3E01\nEPISODE\nCELOS DECLARADOS: Fresia confronts Uva Reyes about her relationship with Limón Duarte. Uva refuses to compete and insists she will only trust actions, not promises.\n\nIdioma: neutral Latin American Spanish.\nConstraints: exactly one Fresia, Limón and Uva, never duplicated.",
  "Fresia",["Uva","Limón"]],
 ["pregnancy",
  "STORY\nHOOK: MENTIRA PATERNAL\nEPISODE INTENT: Fresia le cuenta a Mango Del Rio que está embarazada y le hace creer que el bebé es suyo.\n\nCAMERA\nNo accidental subtitles.",
  "Fresia",["Mango"]],
 ["kiss",
  "EPISODE\nBESO REVELADOR: Limón Duarte kisses Uva Reyes in the hacienda garden. Fresia sees the kiss from a distance.\n\nNARRATIVE NOVELTY LOCK\nNo canon contradictions.",
  "Limón",["Uva"]],
 ["humiliation",
  "EPISODE\nFresia insulta a Uva Reyes delante de Limón Duarte y la llama criada atrevida, generando un nuevo enfrentamiento.\n\nCamera: close-up.",
  "Fresia",["Uva"]],
 ["death",
  "EPISODE\nBanana muere en el hospital acompañado por Don Melón. Su fallecimiento deja a la familia devastada.\n\nConstraints: no duplicates.",
  "Banana",["Don Melón"]],
 ["poison",
  "EPISODE\nMango Del Rio envenena a Banana en secreto durante una reunión en la hacienda.\n\nCAMERA\nDramatic framing.",
  "Mango",["Banana"]]
];
for(const [id,prompt,name,others] of cases){
 const out=generate(prompt);
 assert(!out.error,id+": "+JSON.stringify(out));
 assert(out.title.length<=100,id+" title overflow");
 assert(/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+:/.test(out.title),id+" hook format");
 assert(out.title.includes(name),id+" wrong lead");
 for(const person of others)assert(out.description.includes(person),id+" missing "+person);
 assert(out.description.includes("¿"),id+" no narrative question");
 assert(out.description.endsWith("#Shorts #ViralShorts #FruttiDrama"),id+" missing hashtags");
 assert(!/one continuous|unbroken take|no duplicates|reference sheets|camera/i.test(out.description),id+" leaked production prompt");
 console.log("PASS",id,"TITLE",out.title,"DESC",out.description.slice(0,280).replace(/\n/g," | "));
}
const expectedSubjects=[
 ["pregnancy","MENTIRA PATERNAL: Fresia engaña a Mango","Fresia le anuncia a Mango"],
 ["kiss","BESO REVELADOR: Limón besa a Uva","Fresia presencia el beso"],
 ["humiliation","HUMILLACIÓN CRUEL: Fresia humilla a Uva","Fresia humilla a Uva"],
 ["poison","VENENO MORTAL: Mango envenena a Banana","Mango cruza un límite"]
];
for(const [id,titlePart,descriptionPart] of expectedSubjects){
 const sample=cases.find(x=>x[0]===id);
 const meta=generate(sample[1]);
 assert(meta.title.startsWith(titlePart),id+": incorrect actor, recipient or grammar: "+meta.title);
 assert(meta.description.includes(descriptionPart),id+": narrative reverses characters: "+meta.description);
}
const kiss=generate(cases.find(x=>x[0]==="kiss")[1]);
assert(kiss.description.includes("¿Cómo reaccionará Fresia"),"question must respect witness already present, no false suspense");
const irrelevant=generate(technical);
assert(irrelevant.error,"technical-only prompt must be rejected");
const canonOnly=generate("CANON\nMango envenena a Banana.\nCREATIVE BIBLE\nDrama for 10 seconds. Camera close-ups. Character identity fixed.");
assert(canonOnly.error,"CANON-only prompt must never become the episode story");
console.log("PASS production instructions and canon excluded; no network or AI credentials");
