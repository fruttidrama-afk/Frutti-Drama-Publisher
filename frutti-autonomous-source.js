// FruttiDrama autonomous source-stage showrunner contract.
// Model is allowed to CREATE the next episode's hook, story, headline, caption
// together BEFORE Flow. It must NEVER analyze a completed Flow prompt/video to
// invent copy. This module only validates original source-stage authorship.
import {buildFruttiSourceCopy} from "./frutti-creative-package.js";
const clean=(value,max)=>String(value??"").replace(/\s+/g," ").trim().slice(0,max);
const canonKey=s=>clean(s,2500).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export function createFruttiShowrunnerInstruction({season,episode,creativeBible,canon,previous=[],existing=[]}={}){
 if(!Number.isInteger(season)||season<1||!Number.isInteger(episode)||episode<1)
  throw Error("FRUTTI_SHOWRUNNER_EPISODE_ID_REQUIRED");
 const prior=Array.isArray(previous)?previous.slice(-10):[];
 const register=Array.isArray(existing)?existing.slice(-45):[];
 return[
  "You are the ORIGINAL CREATIVE EPISODE WRITER for FruttiDrama, not a prompt/video analyzer.",
  "Create one NEW serialized micro-episode and its FULL YouTube editorial copy AS ONE decision, before any Google Flow video prompt is built.",
  "Return exactly one JSON object (not markdown). Keys: hook, story, publicationHook, titleCore, descriptionCore.",
  "hook: concise memorable original planning beat (may be two or three words).",
  "story: specific present-tense 10-second dramatic event with 2–3 sequential beats, named actor(s), action, consequence, final turn. Up to THREE visible characters. Do not repeat the previous beat.",
  "publicationHook: EXACTLY TWO uppercase Spanish words expressing the CENTRAL current event. Not a generic label.",
  "titleCore: short, complete, punchy Spanish phrase stating the central act; NO hashtags, ellipsis, draft markers, episode numbers or vague promise.",
  "descriptionCore: 1–2 natural sentences in Latin American Spanish detailing ONLY the NEW EPISODE's actions and consequences. Do not quote the Creative Bible or production directives. NO hashtags.",
  "Canonical tags #Shorts #ViralShorts #FruttiDrama are added by the system to BOTH fields; completed YouTube title including hashtags is <=100 characters.",
  "Do not reuse an earlier episode's event, rename previous events, invent a resurrection, replace the supplied character visual assets, or confuse a suspicion with proof.",
  "The absurd fruit premise is treated with absolute telenovela seriousness. The main setting is Hacienda Melón. No more than 3 characters on screen.",
  "IMPORTANT: titleCore and descriptionCore are ORIGINAL COPY created together with story, NOT extracted or inferred later from any generated prompt.",
  "FruttiDrama Season "+season+", Episode "+episode+".",
  "Current Show Bible:\n"+clean(creativeBible,14000),
  "Current permanent canon:\n"+clean(canon,7000),
  "Recent serialized continuity (do not restage these beats):\n"+JSON.stringify(prior.map(x=>({episode:x.episode,hook:clean(x.hook,150),story:clean(x.story,850),status:clean(x.status,50)}))),
  "Existing episodes for anti-repeat comparison:\n"+JSON.stringify(register.map(x=>({episode:x.episode,hook:clean(x.hook,100),story:clean(x.story,350)}))),
  "Output valid standalone JSON only; do not wrap in code fences or labels."
 ].join("\n\n");
}
export function validateFruttiShowrunnerOutput(raw,{season,episode,previous=[],existing=[]}={}){
 if(!Number.isInteger(season)||!Number.isInteger(episode))throw Error("FRUTTI_SHOWRUNNER_ID_REQUIRED");
 const src=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:null;
 if(!src)throw Error("FRUTTI_SHOWRUNNER_JSON_OBJECT_REQUIRED");
 const authored={
  hook:clean(src.hook,100),story:clean(src.story,1000),publicationHook:clean(src.publicationHook,100),
  titleCore:clean(src.titleCore,300),descriptionCore:clean(src.descriptionCore,3800)
 };
 for(const key of Object.keys(authored))if(!authored[key])throw Error("FRUTTI_SHOWRUNNER_MISSING_"+key.toUpperCase());
 if(authored.story.length<45||authored.story.length>1000)throw Error("FRUTTI_SHOWRUNNER_STORY_LENGTH");
 if(/^(next chapter|new turn|new episode|giro inesperado|nuevo drama)$/i.test(authored.hook))
  throw Error("FRUTTI_SHOWRUNNER_GENERIC_BEAT");
 const packageCopy=buildFruttiSourceCopy(authored);
 const newer=canonKey(authored.hook+" "+authored.story),storyKey=canonKey(authored.story);
 if(!newer||storyKey.length<25)throw Error("FRUTTI_SHOWRUNNER_EMPTY_STORY");
 for(const row of [...previous,...existing]){
  const prior=canonKey(String(row.hook||"")+" "+String(row.story||""));
  const oldStory=canonKey(String(row.story||""));
  if(prior===newer||oldStory===storyKey)throw Error("FRUTTI_SHOWRUNNER_DUPLICATE_PRIOR_STORY");
 }
 return {...authored,season,episode,title:packageCopy.title,description:packageCopy.description,sourceMethod:"autonomous_episode_showrunner_v1"};
}
