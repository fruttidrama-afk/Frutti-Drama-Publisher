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


// Recovered original hook-story architecture regression:
// historical automation made metadata from structured story BEFORE Flow;
// a human-pasted Flow prompt can have NO such label, so require grounded prose fallback.
const naturalFlowScenes=[
 ["clinical", "One continuous shot. @Don Melón reads a clinical report about Banana and looks devastated. He holds the paper with shaking hands.\nCAMERA: slow push-in.", /Don Melón lee un informe médico/],
 ["theft", "SCENE 1: Mango Del Rio steals a letter from Don Melón's office while nobody is watching.\nLighting: warm dusk.", /Mango roba una carta/],
 ["box", "ESCENA 1: Uva Reyes opens a wooden box in the garden. Limón Duarte watches her.", /Uva abre una caja/],
 ["accusation", "CANON\nMango envenenó a Banana en el pasado.\nSCENE 1: Fresia acusa a Mango de mentirle a Uva.", /Fresia acusa a Mango/],
 ["humiliation", "One continuous shot. Fresia walks into the garden and insults Uva Reyes. Limón Duarte only sits beside Uva, no romantic conversation.", /Fresia humilla a Uva/],
 ["actual-romance", "SCENE 1: Uva Reyes and Limón Duarte share a romantic conversation.\nSCENE 2: Fresia enters and interrupts them.", /Fresia interrumpe a Uva y Limón/],
 ["kiss-attempt", "SCENE 1: Limón Duarte tries to kiss Uva Reyes, but she steps back.", /Limón intenta besar a Uva/],
 ["witness", "SCENE 1: Uva Reyes talks to Limón Duarte in the garden. Fresia watches silently from the window.", /Uva habla con Limón/]
];
for(const [id,source,expected] of naturalFlowScenes){
 const meta=generate(source);
 assert(!meta.error,"unstructured Flow story "+id+" should be recognized: "+JSON.stringify(meta));
 assert(expected.test(meta.title),"unstructured Flow story "+id+" has wrong subject, action, or object: "+meta.title);
 assert(meta.title.length<=100,"YouTube title overflow "+id);
 assert(meta.description.endsWith("#Shorts #ViralShorts #FruttiDrama"),"YouTube tags "+id);
}
const unrelatedWitness=generate("One continuous scene. Fresia enters the garden and insults Uva Reyes, while Limón Duarte sits beside Uva.");
assert(!/ROMANCE INTERRUMPIDO|interrumpe a Uva y Limón/.test(unrelatedWitness.title),
 "mere co-presence is NOT proof of a romantic conversation");
const honestTechnicalOnly=generate("Generate one video, vertical 9:16, no subtitles, camera close-up and reference sheets.");
assert(honestTechnicalOnly.error,"technical-only prompts must remain rejected instead of hallucinating a plot");
console.log("PASS unlabeled scene prose, physical actions, spoken roles, no false romance or canon contamination");

// REGRESSION: Legacy factory prompt originally embedded hook/story as a two-field
// contract. Do NOT attempt to infer a different event from surrounding CANON.
const legacyFlow=[
 "FRUTTIDRAMA — Season 2, Episode 9. Vertical 9:16, exactly ten seconds.",
 "CANON / CONTINUITY",
 "Mango poisoned Banana in a past episode; the poisoning must not be the title.",
 "EPISODE",
 "CRIADA ATREVIDA: Fresia interrumpe la conversación entre Uva Reyes y Limón Duarte en el jardín y humilla a Uva con un insulto.",
 "STRICT ANTI-GLITCH",
 "No duplicates."
].join("\n");
const structured=generate(legacyFlow);
assert(!structured.error,"legacy EPISODE hook/story must be recognized");
assert(/^CRIADA ATREVIDA: Fresia interrumpe a Uva y Limón/.test(structured.title),
 "Never truncate the pair into 'Fresia interrumpe a Uva'");
assert(structured.description.includes("interrumpe la conversación entre Uva Reyes y Limón Duarte"),
 "Description must preserve complete source relationship");
assert(!/Mango envenen/.test(structured.title),"canon must not become current story");
const legacySuspicion=generate("EPISODE\nSOSPECHA CRECIENTE: Fresia sospecha que Mango pudo haber envenenado a Banana, pero no tiene pruebas.");
assert(!legacySuspicion.error,"legacy suspicion story must be processed");
assert(/sospecha/.test(legacySuspicion.title.toLowerCase()),"must not present suspicion as proven poisoning");
const legacyConfront=generate("EPISODE\nCELOS DECLARADOS: Fresia confronts Uva Reyes about her relationship with Limón Duarte. Uva refuses to compete and insists she will only trust actions, not promises.");
assert(!legacyConfront.error,"long structured confrontations need a grounded full title");
assert(/Fresia enfrenta a Uva por su relación con Limón/.test(legacyConfront.title),
 "Shortening must preserve actor, addressee and explicitly stated third-person motive");
const witnessedKiss=generate("EPISODE\nBESO REVELADOR: Limón Duarte kisses Uva Reyes in the hacienda garden. Fresia sees the kiss from a distance.");
assert(witnessedKiss.title.startsWith("BESO REVELADOR: Limón besa a Uva"),"kiss must preserve actor and recipient");
assert(witnessedKiss.description.includes("Fresia presencia el beso"),"kiss witness must be described in Spanish without invented acts");
const foundNotInterrupted=generate("EPISODE\nENCUENTRO INESPERADO: Fresia encuentra a Uva y Limón conversando en el jardín.");
assert(!/interrumpe/.test(foundNotInterrupted.title+" "+foundNotInterrupted.description),"finding the pair must not become an interruption");
console.log("PASS 2026 legacy hook/story contract and coordinated-person fidelity");


// v26 current-episode extraction must outrank all previous CANON and technical prose.
const currentStructured = generate([
  "FRUTTIDRAMA — Episode 13",
  "CONTINUITY",
  "Previous canonical beat: SOSPECHA ABIERTA — Fresia acusa a Mango de envenenar a Banana.",
  "Permanent canon: Mango envenenó a Banana años atrás.",
  "STORY / ACTION",
  "HOOK: PRUEBA TÓXICA",
  "STORY: Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural.",
  "CAMERA",
  "Close-up and ambient audio."
].join("\n"));
assert(currentStructured.title.startsWith("PRUEBA TÓXICA: Don Melón recibe"),"HOOK/STORY precedence: "+JSON.stringify(currentStructured));
assert(currentStructured.description.includes("Uva Reyes comprende"),"Current episode second beat lost");
assert(!/Fresia|Mango|SOSPECHA ABIERTA/.test(currentStructured.title+" "+currentStructured.description),"Canon leaked into current metadata");
assert.equal(currentStructured.source_story,
 "Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural.",
 "Metadata must contain every verb and qualification of the current STORY");
const currentRomance = generate("CONTINUITY\nBanana's death was previously revealed.\nSTORY / ACTION\nHOOK: ROMANCE INTERRUMPIDO\nSTORY: Fresia interrumpe una conversación romántica entre Uva Reyes y Limón Duarte en el jardín.");
assert(currentRomance.title.startsWith("ROMANCE INTERRUMPIDO: Fresia interrumpe"),"Current romantic interruption wrong");
assert(currentRomance.description.includes("entre Uva Reyes y Limón Duarte"),"Both interrupted partners must be retained");
const currentAccusation = generate("STORY / ACTION\nHOOK: ACUSACIÓN DIRECTA\nSTORY: Fresia acusa a Mango de envenenar a Banana delante de Uva.");
assert(currentAccusation.title.startsWith("ACUSACIÓN DIRECTA: Fresia acusa"),"False statement of poisoning");
const currentAttempt = generate("STORY / ACTION\nHOOK: BESO INTENTADO\nSTORY: Fresia intenta besar a Limón Duarte, pero él se aleja.");
assert(currentAttempt.title.startsWith("BESO INTENTADO: Fresia intenta"),"Attempted kiss changed to completed");
const canonFieldsOnly = generate("CONTINUITY\nHOOK: SOSPECHA ABIERTA\nSTORY: Mango envenena a Banana.\nCAMERA\nOne unbroken take.");
assert(canonFieldsOnly.error,"Never use HOOK/STORY fields inside CONTINUITY");
console.log("PASS v26 exact current episode structural precedence + literal event contract + canon-only safety");


const operatorClinical=generate("OPERATOR_VERIFIED_STORY: Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural.");
assert(!operatorClinical.error,"operator clinical story must generate: "+JSON.stringify(operatorClinical));
assert(operatorClinical.title.startsWith("PRUEBA TÓXICA: Don Melón recibe"),"operator story must not become a poisoning by Banana");
assert(operatorClinical.description.includes("Uva Reyes comprende que no fue una muerte natural"),"complete operator medical story must survive");
assert(!/Banana envenena a Don Melón|Mango|Fresia/.test(operatorClinical.title+" "+operatorClinical.description),"operator medical story must not hallucinate a perpetrator");
assert(operatorClinical.method==="operator_story_literal_v27","operator input must use literal path, not old heuristic");
console.log("PASS operator-supplied medical story factual fidelity; no poisoning reassignment");


// CANONICAL-COLLAPSED-20: 20 distinct canonical storyboard cases × 5
// layout variations. These archived test prompts are NOT verified matches
// for the 31 actual MP4 files; their expected current STORY is unambiguous.
const canonical20=archive.prompts.slice(13,33);
assert.equal(canonical20.length,20,"canonical collapsed corpus must have 20 episodes");
const canonicalFormats=[
 (prev,row)=>"FRUTTIDRAMA\nCONTINUITY\nPrevious canonical beat: "+prev.hook+" — "+prev.story+"\nPermanent canon: Mango poisoned Banana historically.\nSTORY / ACTION\nHOOK: "+row.hook+"\nSTORY: "+row.story+"\nCAMERA\nClose-up.",
 (prev,row)=>"CONTINUITY Previous canonical beat: "+prev.hook+" — "+prev.story+"\nSTORY / ACTION HOOK: "+row.hook+" STORY: "+row.story+"\nCAMERA: dramatic shot.",
 (prev,row)=>"CONTINUITY Previous canonical beat: "+prev.hook+" — "+prev.story+" STORY / ACTION HOOK: "+row.hook+" STORY: "+row.story+" CAMERA: dramatic shot.",
 (prev,row)=>"## CONTINUITY\nPrevious canonical beat: "+prev.hook+" — "+prev.story+"\n## STORY / ACTION:\n**HOOK:** "+row.hook+"\n**STORY:** "+row.story+"\n## CAMERA\nClose-up.",
 (prev,row)=>"CONTINUITY\nHOOK: "+prev.hook+"\nSTORY: "+prev.story+"\nSTORY / ACTION:\nHOOK: "+row.hook+"\nSTORY: "+row.story+"\nOUTPUT CONSTRAINTS\n10 seconds."
];
const canonicalHookOverrides={"ORDEN DE SALIDA":"SALIDA FORZADA","FURIA DEL PATRÓN":"FURIA PATRONAL"};
let canonicalPasses=0;
for(let i=0;i<canonical20.length;i++){
 const current=canonical20[i],previous=archive.prompts[12+i];
 const targetHook=canonicalHookOverrides[current.hook]||current.hook;
 for(let j=0;j<canonicalFormats.length;j++){
  const out=generate(canonicalFormats[j](previous,current));
  const id="canonical T"+current.season+"E"+current.episode+" layout "+j;
  assert(!out.error,id+" generation failed: "+JSON.stringify(out));
  assert.equal(out.source_story,current.story,id+" extracted previous beat instead of current STORY");
  assert(out.title.startsWith(targetHook+": "),id+" wrong HOOK: "+out.title);
  assert(out.description.includes(current.story),id+" lost complete current story");
  assert(!out.description.includes(previous.story),id+" previous canonical beat leaked");
  assert(out.title.length<=100,id+" YouTube title overflow");
  assert(!/CONTINUITY Previous canonical beat/.test(out.episode_excerpt||""),id+" source evidence from wrong section");
  canonicalPasses++;
 }
}
assert.equal(canonicalPasses,100,"20 episodes × 5 formats = 100");
for(const [bad,shouldError] of [
 ["CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango.\nCAMERA: close-up.",true],
 ["CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango. STORY / ACTION HOOK: PRUEBA TÓXICA CAMERA: close-up.",true],
 ["CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango. STORY / ACTION STORY: Don Melón recibe un informe. CAMERA: close-up.",true]
]){
 const out=generate(bad);
 assert.equal(!!out.error,shouldError,"never hallucinate a current beat from previous canon");
}
const actualProblem=generate("CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango Del Rio por su reacción ante la muerte de Banana. Mango evita responder y deja a Fresia convencida de que esconde algo grave. STORY / ACTION HOOK: PRUEBA TÓXICA STORY: Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural. CAMERA: close-up.");
assert(actualProblem.title.startsWith("PRUEBA TÓXICA: Don Melón recibe"),"exact screenshot-style collapsed prompt: "+JSON.stringify(actualProblem));
assert(!/Fresia|Mango|SOSPECHA ABIERTA/.test(actualProblem.title+" "+actualProblem.description),"previous beat contaminated metadata");
assert(actualProblem.description.includes("Uva Reyes comprende que no fue una muerte natural"),"current plot conclusion missing");
console.log("PASS CANONICAL-COLLAPSED-20: 20 canonical episodes, 100 variants, fail-closed previous-beat guards");


// LONG-FLOW-20-BLOCKS: regression of real iPad incident (CURRENT_STORY_TOO_LONG).
// 20 canonical episodes × 6 Flow layout variants × 2500-6000 chars of
// production guidance after STORY. These archived prompts are testing fixtures,
// not verified mappings to 20 of the 31 original MP4 files.
const longAfterStory=[
 "NARRATIVE NOVELTY LOCK",
 "This must be a materially new plot event, not a paraphrase of a previous episode. ".repeat(12),
 "EXACT 10-SECOND / 2–3 BEAT RHYTHM",
 "Beat 1 (0.0–2.5s): immediate first-second dramatic visual hook. ".repeat(12),
 "DIALOGUE",
 "One speaker at a time, no overlapping lines. ".repeat(13),
 "STRICT ANTI-GLITCH",
 "Never duplicate characters or rewrite past beats. ".repeat(13),
 "OUTPUT CONSTRAINTS",
 "9:16 vertical, 10s. ".repeat(20)
].join("\n");
const altLongAfterStory=[
 "CHARACTER REFERENCE LOCK",
 "Preserve exact subject visual identity. ".repeat(22),
 "SHOT-BY-SHOT TIMING:",
 "Scene 1 (0–3s): no mutation. ".repeat(20),
 "SCENE 2 (3–8s): keep the same actors. ".repeat(25),
 "SOUND DESIGN:",
 "Continuous roomtone. ".repeat(30),
 "TECHNICAL INSTRUCTIONS:",
 "Match the supplied fixed reference sheets. ".repeat(25)
].join("\n");
const longVariants=[
 (p,r)=>"CONTINUITY\nPrevious canonical beat: "+p.hook+" — "+p.story+"\nSTORY / ACTION\nHOOK: "+r.hook+"\nSTORY: "+r.story+"\n"+longAfterStory,
 (p,r)=>"CONTINUITY Previous canonical beat: "+p.hook+" — "+p.story+"\nSTORY / ACTION HOOK: "+r.hook+" STORY: "+r.story+"\n"+longAfterStory,
 (p,r)=>"CONTINUITY Previous canonical beat: "+p.hook+" — "+p.story+" STORY / ACTION HOOK: "+r.hook+" STORY: "+r.story+" CAMERA: closeups. "+"No duplicate characters. ".repeat(125),
 (p,r)=>"## CONTINUITY\nPrevious canonical beat: "+p.hook+" — "+p.story+"\n## STORY / ACTION:\n**HOOK:** "+r.hook+"\n**STORY:** "+r.story+"\n## CINEMATOGRAPHY:\n"+altLongAfterStory,
 (p,r)=>"CONTINUITY\nHOOK: "+p.hook+"\nSTORY: "+p.story+"\nSTORY / ACTION:\nHOOK: "+r.hook+"\nSTORY: "+r.story+"\n"+altLongAfterStory,
 (p,r)=>"CONTINUITY Previous canonical beat: "+p.hook+" — "+p.story+"\nSTORY / ACTION HOOK: "+r.hook+" STORY: "+r.story+"\n\nEXACT 10-SECOND / 2–3 BEAT RHYTHM\n0–2s — immediate dramatic hook.\n2–6.5s — development of conflict.\n"+altLongAfterStory
];
const hookReshape={"ORDEN DE SALIDA":"SALIDA FORZADA","FURIA DEL PATRÓN":"FURIA PATRONAL"};
let longCount=0;
for(let i=13;i<33;i++){
 const previous=archive.prompts[i-1],current=archive.prompts[i];
 for(let variant=0;variant<6;variant++){
  const prompt=longVariants[variant](previous,current),out=generate(prompt);
  const id="LONG-FLOW-20-BLOCKS T"+current.season+"E"+current.episode+" variant "+variant;
  assert(prompt.length>1800,id+": invalid stress fixture length");
  assert(!out.error,id+": extraction error "+JSON.stringify(out));
  assert.equal(out.source_story,current.story,id+": wrong source narrative");
  assert(out.title.startsWith((hookReshape[current.hook]||current.hook)+": "),id+": title incorrectly uses previous beat");
  assert(out.title.length<=100,id+": YouTube title limit");
  assert(out.description.includes(current.story),id+": full current narrative missing");
  assert(!out.description.includes(previous.story),id+": previous beat contaminates description");
  assert(!/NARRATIVE NOVELTY LOCK|STRICT ANTI.GLITCH|SHOT.BY.SHOT TIMING|TECHNICAL INSTRUCTIONS/.test(out.description),id+": copied production instruction");
  longCount++;
 }
}
assert.equal(longCount,120,"20 distinct episodes × 6 long layouts");
const screenshotPrompt=[
 "CONTINUITY",
 "Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango Del Rio por su reacción ante la muerte de Banana. Mango evita responder y deja a Fresia convencida de que esconde algo grave.",
 "STORY / ACTION",
 "HOOK: PRUEBA TÓXICA",
 "STORY: Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural.",
 longAfterStory
].join("\n");
const screenshotCopy=generate(screenshotPrompt);
assert(!screenshotCopy.error,"screenshot-style prompt must not trigger CURRENT_STORY_TOO_LONG");
assert(screenshotCopy.title.startsWith("PRUEBA TÓXICA: Don Melón recibe"),"screenshot-style title changes narrative");
assert(screenshotCopy.description.includes("Uva Reyes comprende que no fue una muerte natural"),"screenshot-style final story sentence lost");
assert(!/Mango|Fresia/.test(screenshotCopy.title+" "+screenshotCopy.description),"previous canonical beat used as current story");
console.log("PASS LONG-FLOW-20-BLOCKS: 20 canonical episodes x 6 long-format variants, 120/120; 1 screenshot regression");


// UNKNOWN-HEADING-CANONICAL-20: real regression for iPad's
// CURRENT_STORY_BOUNDARY_AMBIGUOUS with unknown production headings.
// 20 different canonical stories x 6 hostile Flow prompt layouts; these are
// test fixtures, NOT claimed links to 20 verified historical MP4s.
const unknownHeadingLong="Maintain the fixed reference assets, locked fruit faces, one voice at a time, no duplicate characters or frame glitch. ".repeat(35);
const weirdLayouts=[
 (p,c)=>"CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION HOOK: "+c.hook+" STORY: "+c.story+" Camera choreography and acting: "+unknownHeadingLong,
 (p,c)=>"CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION\nHOOK: "+c.hook+"\nSTORY: "+c.story+"\n\nCamera choreography and acting:\n"+unknownHeadingLong,
 (p,c)=>"CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION\nHOOK: "+c.hook+"\nSTORY: "+c.story+"\nThe characters are the same fixed assets and must remain stable. "+unknownHeadingLong,
 (p,c)=>{const words=c.story.split(" "),half=Math.floor(words.length/2);return "CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION\nHOOK: "+c.hook+"\nSTORY:\n"+words.slice(0,half).join(" ")+"\n"+words.slice(half).join(" ")+"\nThe characters are the same fixed assets. "+unknownHeadingLong},
 (p,c)=>"CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION\nHOOK: "+c.hook+"\nSTORY: "+c.story+"\n\nAction choreography:\n"+unknownHeadingLong,
 (p,c)=>"CONTINUITY Previous canonical beat: "+p.story+"\nSTORY / ACTION\nHOOK: "+c.hook+"\nSTORY: "+c.story+"\n--- Production notes: "+unknownHeadingLong
];
let weirdCount=0;
for(let i=13;i<33;i++){
 const previous=archive.prompts[i-1],current=archive.prompts[i];
 for(let j=0;j<weirdLayouts.length;j++){
  const p=weirdLayouts[j](previous,current),out=generate(p);
  const id="UNKNOWN-HEADING-CANONICAL-20 T"+current.season+"E"+current.episode+" format "+j;
  assert(p.length>1800,id+": scenario not long enough to exercise bug");
  assert(!out.error,id+": "+JSON.stringify(out));
  assert.equal(out.source_story,current.story,id+": STORY includes production text or previous beat");
  assert(out.title.startsWith((hookReshape[current.hook]||current.hook)+": "),id+": hook contaminated by previous episode");
  assert(out.description.includes(current.story),id+": lost current plot");
  assert(!out.description.includes(previous.story),id+": previous plot leaked into description");
  assert(out.title.length<=100,id+": YouTube title overflow");
  weirdCount++;
 }
}
assert.equal(weirdCount,120,"20 canonical episodes must pass all 120 unknown-heading tests");
const fakeNonStory=generate("CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia acusa a Mango. STORY / ACTION HOOK: PRUEBA TÓXICA STORY: Use the character reference sheet and maintain scene stability.\nThe characters are the same fixed assets. "+unknownHeadingLong);
assert(fakeNonStory.error,"Technical instructions alone must not be treated as narrative");
const unknownReal=generate("CONTINUITY Previous canonical beat: SOSPECHA ABIERTA — Fresia confronta a Mango Del Rio. STORY / ACTION HOOK: PRUEBA TÓXICA STORY: Don Melón recibe una prueba médica que confirma que la muerte de Banana estuvo relacionada con un envenenamiento. Uva Reyes comprende que no fue una muerte natural.\n\nCamera choreography and acting: "+unknownHeadingLong);
assert(!unknownReal.error,"Prueba tóxica must survive long unknown technical headings");
assert(unknownReal.title.startsWith("PRUEBA TÓXICA: Don Melón recibe"),"Prueba tóxica hook must be current plot");
assert(unknownReal.description.includes("Uva Reyes comprende que no fue una muerte natural"),"Second current story beat lost");
assert(!/Fresia|Mango/.test(unknownReal.title+" "+unknownReal.description),"Previous canonical beat leaked");
console.log("PASS UNKNOWN-HEADING-CANONICAL-20: 20 episodes x 6 long formats = 120/120; technical-only fail-close and screenshot incident");


// v34 regression: twenty different canonical episode stories x ten
// nonstandard technical-boundary layouts, including collapsed one-line Flow
// copy. Historical Prompt Studio rows are fixtures, never verified MP4 links.
const boundary20=archive.prompts.slice(13,33);
const boundaryProduction="Match the locked character identity and facial fruit material, avoid duplicate subjects and lip sync errors, maintain static camera and lighting. ".repeat(25);
const boundaryLayouts=[
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION HOOK: "+current.hook+" STORY: "+current.story+"\nThe characters are the same fixed assets, enforce identity fidelity. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+" STORY / ACTION HOOK: "+current.hook+" STORY: "+current.story+" The characters are the same fixed assets, enforce identity fidelity. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+"\nEnsure every shot preserves reference sheets. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+"\nDirector intent: enforce correct asset identity. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+"\n## DIRECTOR INSTRUCTIONS\n"+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+" The performance should preserve actor identity and shot consistency. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+" Preserve exact character reference assets and avoid glitches. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+" Mantener la identidad de los personajes y el render original. "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+"\nCAMERA: "+boundaryProduction,
 (previous,current)=>"CONTINUITY Previous canonical beat: "+previous.story+"\nSTORY / ACTION\nHOOK: "+current.hook+"\nSTORY: "+current.story+"\n\nCamera choreography and acting: "+boundaryProduction
];
let boundaryProof=0;
for(let i=13;i<33;i++)for(let variant=0;variant<boundaryLayouts.length;variant++){
 const previous=archive.prompts[i-1],current=archive.prompts[i];
 const prompt=boundaryLayouts[variant](previous,current),copy=generate(prompt);
 const label="V34 current-only T"+current.season+"E"+current.episode+" boundary="+variant;
 assert(prompt.length>1800,label+" malformed stress fixture");
 assert(!copy.error,label+" rejected: "+JSON.stringify(copy));
 assert.equal(copy.source_story,current.story,label+" trimmed story or copied technical guidance");
 assert(!copy.description.includes(previous.story),label+" leaked previous beat");
 assert(copy.description.includes(current.story),label+" dropped current plot");
 assert(!copy.description.includes("locked character identity"),label+" leaked technical instructions");
 assert(copy.title.length<=100,label+" YouTube length");
 boundaryProof++;
}
assert.equal(boundaryProof,200,"v34 must pass twenty episodes x ten variants");
const technicalStoryOnly=generate("CONTINUITY Previous canonical beat: Fresia acusa a Mango. STORY / ACTION HOOK: PRUEBA TÓXICA STORY: Use fixed character reference sheets and render the entire scene. The characters are the same fixed assets. "+boundaryProduction);
assert(technicalStoryOnly.error,"v34 cannot mistake technical instructions alone for a plot");
const threeBeatCurrent=generate("CONTINUITY Previous canonical beat: Mango acusa a Fresia. STORY / ACTION HOOK: ROMANCE INTERRUMPIDO STORY: Fresia interrumpe una conversación romántica entre Uva Reyes y Limón Duarte. Uva y Limón permanecen en silencio. The characters are the same fixed assets and preserve shot identity. "+boundaryProduction);
assert(!threeBeatCurrent.error,"v34 three-actor romance failed: "+JSON.stringify(threeBeatCurrent));
assert(threeBeatCurrent.source_story.includes("Uva y Limón permanecen en silencio"),"v34 dropped second narrative beat");
assert(!threeBeatCurrent.source_story.includes("fixed assets"),"v34 included production instruction");
console.log("PASS V34-COLLAPSED-BOUNDARY: 20 canonical stories x 10 layouts = 200/200 plus negative and multi-beat guards");


// RECOVER-HISTORICAL-METADATA-12: the original legacy queue.js T2_CANON
// is a verified code-level record, not proof of a later YouTube manual edit.
const legacyMetadataScript=fs.readFileSync("supabase/functions/publisher-frutti-recap/legacy-metadata.js","utf8");
const legacyMeta=await import("data:text/javascript;base64,"+Buffer.from(legacyMetadataScript).toString("base64"));
const historical=legacyMeta.LEGACY_FRUTTI_METADATA;
assert.equal(historical.length,12,"recover T2 E2-E13 canonical metadata only");
assert.equal(legacyMeta.LEGACY_METADATA_SOURCE,"fruttidrama-afk/FruttiDrama-Publisher/queue.js:T2_CANON","source of archival titles must be explicit");
const uniqueEpisodes=new Set();
for(const e of historical){
 const key="T"+e.season+"E"+e.episode;
 assert.equal(e.season,2,key+": historical season must be 2");
 assert(e.episode>=2&&e.episode<=13,key+": no invented archival episode beyond original source");
 assert(!uniqueEpisodes.has(key),key+": duplicate archival metadata");
 uniqueEpisodes.add(key);
 assert(e.title.length<=100,key+": original title length");
 assert(/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+:/.test(e.title),key+": canonical title structure");
 assert(e.description.endsWith("#Shorts #ViralShorts #FruttiDrama"),key+": original description hashtags");
}
assert.equal(historical.find(x=>x.episode===9).title,"CRIADA ATREVIDA: Fresia humilla a Uva frente a Limón #Shorts #ViralShorts #FruttiDrama","T2E9 should be recovered from original source, not generated by current parser");
assert(historical.find(x=>x.episode===9).description.includes("Fresia irrumpe en la conversación entre Uva y Limón"),"T2E9 legacy description must be intact");
assert(!historical.some(x=>x.episode===14||x.season===3),"do not invent metadata for unverified episodes");
const recapAPI=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
assert(recapAPI.includes("historical_metadata:LEGACY_FRUTTI_METADATA"),"owner scoped GET must return archive");
assert(recapAPI.includes('metadata_method:legacyMatch?"legacy_canonical_operator_reviewed":"operator_reviewed"'),"archival metadata must carry provenance on save");
assert(recapAPI.indexOf("const owner=")<recapAPI.indexOf("historical_metadata:LEGACY_FRUTTI_METADATA"),"archive must not bypass owner authorization");
for(const client of ["docs/frutti-recap.js","factory-web/public/frutti-recap.js"]){
 const script=fs.readFileSync(client,"utf8");
 for(const token of ["udRecapRestoreHistorical","historical_metadata","currentHistorical","recoverHistorical(false)","if(currentHistorical())"])
  assert(script.includes(token),client+": missing first-class historical recovery: "+token);
}
console.log("PASS RECOVER-HISTORICAL-METADATA-12: 12 original-source T2 episodes, API provenance, both UI clients, zero inferred S3 metadata");
