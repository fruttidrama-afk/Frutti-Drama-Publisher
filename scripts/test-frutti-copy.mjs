import assert from "node:assert/strict";
import fs from "node:fs";
const edge=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
const script=fs.readFileSync("supabase/functions/publisher-frutti-recap/frutti-recap-copy.js","utf8");
assert(edge.includes('generateFruttiRecapCopy(source)'),"recap must use local narrative package");
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

// The operator's real Flow prompts can be prose, not the factory's original
// HOOK/STORY records. The old parser wrongly rejected technical prose mixed
// with action and missed scenes lacking an EPISODE header.
const proseWithoutEpisodeHeader=[
 "FruttiDrama, hiperrealista 3D, telenovela, one continuous unbroken take.",
 "The Melón family hacienda salon at night. Fresia confronts Uva Reyes while Limón Duarte watches quietly.",
 "Fresia accuses Uva of taking Limón away from her. Uva refuses to compete with her.",
 "Only Fresia speaks: the conversation ends as she leaves.",
 "Idioma: Spanish neutral Latin American. Constraints: exactly 1 Limón Duarte, exactly 1 Uva Reyes, exactly 1 Fresia in frame."
].join("\n");
const noHeader=generate(proseWithoutEpisodeHeader);
assert(!noHeader.error,"Flow prose without labeled EPISODE must be parsed: "+JSON.stringify(noHeader));
assert(noHeader.title.includes("Fresia")&&noHeader.title.includes("Uva"),"title must describe the actual conflict");
assert(!/lighting|one continuous|frame/i.test(noHeader.description),"technical directions leaked");

const mixedScene=[
 "Scene 1 (0–3s): Cinematic lighting, one continuous take.",
 "0–3s: Uva Reyes and Limón Duarte are together in the garden.",
 "3–7s: Fresia confronts Uva Reyes about her relationship with Limón Duarte.",
 "7–10s: Uva Reyes refuses to compete. Fresia walks away furious.",
 "Constraints: exact one character each, no duplicates."
].join("\n");
const beatResult=generate(mixedScene);
assert(!beatResult.error,"timed scenes with no EPISODE header must work: "+JSON.stringify(beatResult));

const inlineScene=generate([
 "SCENE 1: Fresia confronts Uva Reyes in front of Limón Duarte.",
 "SCENE 2: Uva refuses to compete for Limón and defends their relationship.",
 "Constraints: exact 3 fruit humanoids, camera close-up, only Fresia speaks."
].join("\n"));
assert(!inlineScene.error,"inline SCENE 1: dialogue/action must be parsed, not misclassified as empty heading: "+JSON.stringify(inlineScene));
assert(/Fresia.*Uva/.test(inlineScene.title),"inline scene core action must identify both participants");

const irrelevant=generate(technical);
assert(irrelevant.error,"technical-only prompt must be rejected");
const canonOnly=generate("CANON\nMango envenena a Banana.\nCREATIVE BIBLE\nDrama for 10 seconds. Camera close-ups. Character identity fixed.");
assert(canonOnly.error,"CANON-only prompt must never become the episode story");
console.log("PASS production instructions and canon excluded; no network or AI credentials");
