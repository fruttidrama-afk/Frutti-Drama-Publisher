import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

const edge=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
const start=edge.indexOf("const tidy="),end=edge.indexOf("\nDeno.serve(",start);
assert(start>=0&&end>start,"Edge narrative engine must be present");
const body=stripTypeScriptTypes(edge.slice(start,end));
const {draftFromPrompt}=vm.runInNewContext(body+"\n({draftFromPrompt})",Object.create(null));
const canonical=(hook,story)=>`FRUTTIDRAMA — Season 3, Episode 6. Generate 10 seconds.
CANON / CONTINUITY
Banana was poisoned by Mango, developed bananismo múltiple and died. 
VISUAL IDENTITY
Hyperrealistic 3D fruit characters. Use reference sheets.
LOCATION / TONE
One continuous scene, one unbroken take; hacienda telenovela style.
EPISODE
${hook}: ${story}
NARRATIVE NOVELTY LOCK
This must be a materially new plot event.
DIALOGUE
No overlaps.`;
const cases=[
 ["Fresia confronts Uva", canonical("FRESIA CONTRAATACA","Fresia confronta a Uva y le advierte que Limón siempre estará unido a ella por su hijo. Uva responde que la confianza se demuestra con hechos."),"Fresia","Uva"],
 ["Limón rejects reunion", canonical("LÍMITE FINAL","Limón establece un límite con Fresia: juntos criarán a su hijo, pero nunca volverán a ser pareja."),"Limón","Fresia"],
 ["Uva and Limón kiss", canonical("BESO SORPRESA","Uva y Limón se besan a solas en la hacienda; Fresia observa el gesto."),"Uva","Limón"],
 ["Banana death beats past diagnosis",canonical("DOLOR SIN FIN","Banana muere en el hospital tras el diagnóstico de bananismo múltiple; Uva despide a su marido."),"Banana","muerte"],
 ["Mango poisoning",canonical("TRAICIÓN FINAL","Mango envenena a Banana para apartarlo de la familia."),"Mango","Banana"]
];
for(const [label,prompt,a,b] of cases){
 const r=draftFromPrompt(prompt);
 assert(!r.error,label+": "+JSON.stringify(r));
 assert(r.title.length<=100,label+": title overflow");
 assert(/^([A-ZÁÉÍÓÚÜÑ0-9]+) ([A-ZÁÉÍÓÚÜÑ0-9]+): .+/.test(r.title),label+": title must begin with two ALL-CAPS hook words");
 assert(r.description.includes(a)&&r.description.includes(b),label+": missing story character");
 assert(!/one continuous scene|unbroken take|reference sheets|9:16/i.test(r.description),label+": leaked technical prompt");
 assert(/¿[^?]+\?\n\n#Shorts #ViralShorts #FruttiDrama$/.test(r.description),label+": missing editorial question/hashtags");
 console.log("PASS",label,"=>",r.title);
}
const bad="FRUTTIDRAMA 9:16, one continuous scene, one unbroken take; hacienda telenovela style. Use saved reference sheets. No duplicates.";
const fail=draftFromPrompt(bad);
assert(fail.error,"Technical-only prompt must fail closed, not invent generic drama.");
console.log("PASS technical-only prompt fails closed",fail.error);
