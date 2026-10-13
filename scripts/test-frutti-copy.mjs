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
 ["Mango poisoning",canonical("TRAICIÓN FINAL","Mango envenena a Banana para apartarlo de la familia."),"Mango","Banana"],
 ["Fresia states parental bond",canonical("FRESIA CONTRAATACA","Fresia le dice a Uva Reyes que Limón siempre estará unido a ella por su hijo. Uva se niega a competir y le responde que la confianza se demuestra con hechos."),"Fresia","Uva"],
 ["Fresia confronts Limón",canonical("CELOS DE FRESIA","Fresia enfrenta a Limón Duarte a solas y le recuerda que tienen un hijo en común. Limón deja claro que será un padre presente, pero que su relación sentimental con Fresia terminó."),"Fresia","Limón"],
 ["Uva overhears and doubts",canonical("DUDA DE UVA","Uva Reyes escucha una parte de la conversación entre Fresia y Limón Duarte y teme volver a quedar atrapada en un triángulo amoroso. Limón intenta explicarle que eligió estar con ella."),"Uva","Limón"],
 ["Limón promise to Uva",canonical("PROMESA DE LIMÓN","Limón Duarte busca a Uva Reyes y le promete que no repetirá las mentiras del pasado. Uva acepta seguir con la relación, pero le exige transparencia absoluta."),"Limón","Uva"],
 ["Don Melón overhears",canonical("SECRETO ESCUCHADO","Don Melón escucha a Fresia admitir que todavía siente algo por Limón Duarte. Sin intervenir todavía, comprende que el nuevo equilibrio de la hacienda puede romperse."),"Don Melón","Fresia"],
 ["Don Melón warns Fresia",canonical("ADVERTENCIA DE MELÓN","Don Melón confronta a Fresia y le exige que no destruya la relación entre Uva Reyes y Limón Duarte. Fresia asegura que no hará nada, pero su expresión revela conflicto."),"Don Melón","Fresia"],
 ["Fresia admits feelings",canonical("CONFESIÓN DE FRESIA","Fresia admite frente a Uva Reyes que todavía tiene sentimientos por Limón Duarte. Uva no retrocede y le exige que respete la relación que Limón eligió."),"Fresia","Uva"],
 ["Limón confirms choice",canonical("ELECCIÓN DEFINITIVA","Limón Duarte reafirma delante de Uva Reyes y Fresia que quiere construir su futuro con Uva. Fresia se queda sola con una decisión que puede cambiar la temporada."),"Limón","Uva"]
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
