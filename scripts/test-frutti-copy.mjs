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


const userActualScene=generate([
 "FruttiDrama 10s vertical one continuous scene, hyperrealistic 3D hacienda.",
 "SCENE 1: Uva Reyes and Limón Duarte share a romantic conversation in the garden.",
 "SCENE 2: Fresia enters abruptly and interrupts their romantic moment while Uva and Limón look at her.",
 "Only Fresia speaks. Limón Duarte and Uva Reyes say nothing. No duplicate characters."
].join("\n"));
assert(!userActualScene.error,"three-actor romance scene must generate: "+JSON.stringify(userActualScene));
assert(/Fresia.*Uva y Limón/.test(userActualScene.title),"title must identify BOTH interrupted people: "+userActualScene.title);
assert(/conversación romántica entre Uva y Limón/.test(userActualScene.description),"description must narrate the ROMANTIC relation between both: "+userActualScene.description);
assert(!/conversación de Uva\b/.test(userActualScene.description),"one-sided conversation not allowed");
assert(userActualScene.title.length<=100,"title must respect 100-char YouTube limit");
assert(userActualScene.description.endsWith("#Shorts #ViralShorts #FruttiDrama"),"description hashtags missing");

const singleSentence=generate("ESCENA: Fresia irrumpe en medio de una conversación romántica entre Uva Reyes y Limón Duarte en el jardín de la hacienda.");
assert(!singleSentence.error,"single sentence interruption must generate: "+JSON.stringify(singleSentence));
assert(/Fresia.*Uva y Limón/.test(singleSentence.title),"single sentence must mention both partners");
assert(singleSentence.description.includes("conversación romántica entre Uva y Limón"),"single sentence must narrate both");

const businessConversation=generate([
 "Uva Reyes and Limón Duarte are discussing the finances of the hacienda.",
 "Fresia suddenly enters and interrupts their conversation."
].join("\n"));
assert(!businessConversation.error,"non-romantic conversation should generate");
assert(/Fresia.*Uva y Limón/.test(businessConversation.title),"non-romantic interruption needs both interlocutors");
assert(!/romántica/.test(businessConversation.description),"do not invent romance in non-romantic business scene");

const canonLeak=generate([
 "CANON",
 "Limón Duarte once confessed romantic feelings for Uva Reyes.",
 "STORY",
 "Fresia interrumpe a Uva Reyes durante una conversación sin Limón presente."
].join("\n"));
assert(!/interrumpe a Uva y Limón/.test(canonLeak.title||""),"must not invent a third person from historical CANON");
console.log("PASS three-person interrupt, romantic specifics, one sentence, grounded non-romance, canon isolation");
const irrelevant=generate(technical);
assert(irrelevant.error,"technical-only prompt must be rejected");
const canonOnly=generate("CANON\nMango envenena a Banana.\nCREATIVE BIBLE\nDrama for 10 seconds. Camera close-ups. Character identity fixed.");
assert(canonOnly.error,"CANON-only prompt must never become the episode story");
console.log("PASS production instructions and canon excluded; no network or AI credentials");

// Narrative fidelity regression 2026-11-09: do not confuse witnessing with interrupting,
// a suspected assault with a completed assault, or an attempted kiss with a kiss.
const merelyFinds=generate("Fresia encuentra a Uva y Limón conversando románticamente en el jardín de la hacienda.");
assert(!merelyFinds.error,"mere discovery must be usable");
assert(/Fresia encuentra a Uva y Limón/.test(merelyFinds.title),"finding must not become interruption");
assert(!/INTERRUMPIDO|interrumpe|irrumpe/.test(merelyFinds.title+" "+merelyFinds.description),"finding must not become interruption in copy");
assert(merelyFinds.description.includes("conversación romántica"),"romanticity explicitly in the prompt must be preserved");
const deniesInterruption=generate("Fresia no interrumpe a Uva y Limón, que mantienen una conversación romántica.");
assert(deniesInterruption.error,"explicit negation must block incorrect interruption copy");
const merelyAccuses=generate("Fresia acusa a Mango de envenenar a Banana delante de Uva.");
assert(merelyAccuses.error||!/Fresia envenena a Mango/.test(merelyAccuses.title),"accusation must never become the poisoning event");
const kissAttempt=generate("Fresia intenta besar a Limón, pero él se aleja.");
assert(kissAttempt.error||!/Fresia besa a Limón/.test(kissAttempt.title),"attempted kiss must never become consummated kiss");
const mereWitness=generate("Fresia enfrenta a Uva frente a Limón que observa.");
assert(!mereWitness.error,"ordinary confrontation should still be usable");
assert(!/por Limón/.test(mereWitness.title),"witness cannot be rewritten as romantic motive");
console.log("PASS post-recovery narrative fidelity guards");

// Explicit episode and operator-story fidelity corpus. These 50 Prompt Studio
// examples are TEST CASES ONLY, NOT proven mappings for the 31 real MP4s.
const archive=JSON.parse(fs.readFileSync("docs/data/frutti-prompt-studio-active.json","utf8"));
assert.equal(archive.prompts.length,50,"expected complete test corpus");
for(const row of archive.prompts){
 const source=String(row.full_prompt||"");
 const canonical=String(row.story||"").trim();
 const origin=generate(source);
 const operator=generate("OPERATOR_VERIFIED_STORY: "+canonical);
 for(const [mode,copy] of [["prompt",origin],["operator",operator]]){
  const label=mode+" T"+row.season+"E"+row.episode;
  assert(!copy.error,label+" must generate from explicit narrative: "+JSON.stringify(copy));
  assert(copy.title.length<=100,label+" YouTube character limit");
  assert(/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+:/.test(copy.title),label+" exactly two uppercase hook words");
  assert(copy.description.includes(canonical),label+" must contain EVERY word and relationship of original central narrative");
  assert(copy.description.endsWith("#Shorts #ViralShorts #FruttiDrama"),label+" hashtags in ready-to-copy description");
  assert(!/creative bible|character reference sheets|no duplicates|one continuous take/i.test(copy.description),label+" must not leak production instructions");
 }
}
const allegedPoison=generate("OPERATOR_VERIFIED_STORY: Fresia acusa a Mango de envenenar a Banana delante de Uva.");
assert(allegedPoison.title.startsWith("ACUSACIÓN DIRECTA: Fresia acusa"),"operator story must NOT become an actual poisoning");
const attemptedKiss=generate("OPERATOR_VERIFIED_STORY: Fresia intenta besar a Limón, pero él se aleja.");
assert(attemptedKiss.title.startsWith("BESO INTENTADO: Fresia intenta"),"operator story must NOT become a consummated kiss");
const explicitlyDenied=generate("OPERATOR_VERIFIED_STORY: Fresia no interrumpe a Uva y Limón durante su conversación romántica.");
assert(explicitlyDenied.title.startsWith("HECHO NEGADO: Fresia no interrumpe"),"negative clause must not become positive event");
console.log("PASS 50 archived story probes × prompt and operator-summary paths; no historical MP4 mapping inferred");

// A genuine real-world Flow layout has technical @character reference sheets,
// scene action inside the same paragraphs and speech as direct quoted dialogue,
// with NO EPISODE/STORY section. Never drop Limón from the couple.
const originalStylePrompt=[
 "One continuous scene, hacienda garden at dusk.",
 "Use attached @Limón Duarte character reference sheet. Limón Duarte sits close beside Uva on the garden bench.",
 "Use attached @Uva Reyes reference sheet. Uva Reyes sits beside him, the two talking warmly, softly laughing together.",
 "Use attached @Fresia reference sheet. Fresia walks into frame and freezes. Fresia is the ONLY one who speaks:",
 "«¡Uva! Qué criada tan atrevida... ...ni las sobras se te escapan, ¿no?» Fresia turns and walks away.",
 "Limón Duarte and Uva both look up startled but neither speaks.",
 "Cámara: dramatic static wide shot, no subtitles. Constraints: no duplicate characters."
].join("\n");
const recoveredRealStyle=generate(originalStylePrompt);
assert(!recoveredRealStyle.error,"real Flow prose with dialogue must be recoverable");
assert(/Fresia interrumpe a Uva y Limón/.test(recoveredRealStyle.title),"interruption must have BOTH interlocutors");
assert(recoveredRealStyle.title.length<=100,"real Flow prose title must fit YouTube");
assert(/criada tan atrevida/.test(recoveredRealStyle.description),"actual verbal aggression must not be discarded");
assert(/Uva y Limón permanecen en silencio/.test(recoveredRealStyle.description),"must preserve no-response fact");
assert(!/interrumpe a Uva(?! y Limón)/.test(recoveredRealStyle.title),"no one-sided interruption");
console.log("PASS unlabeled original Flow prose with both witnesses, spoken insult and exit");
