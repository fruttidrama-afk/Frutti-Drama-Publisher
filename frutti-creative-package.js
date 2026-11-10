// FRUTTIDRAMA CREATIVE PACKAGE V1
// One source-stage editorial decision emits (prompt, title, description) together.
// This function NEVER receives or parses Flow prompt, previous shot or dialogue.
// Incomplete creative ideas fail closed; never invent metadata during recovery, Review
// or publication. Existing metadata may only be restored from a verified ledger.
export const FRUTTI_TITLE_TAGS="#Shorts #ViralShorts #FruttiDrama";
export const FRUTTI_CREATIVE_PACKAGE_SCHEMA="frutti-creative-package-v1";
const twoWordHook=/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+$/u;
const removeTags=v=>String(v||"").replace(/\s*#(?:Shorts|ViralShorts|FruttiDrama)\b/gi,"").replace(/\s+/g," ").trim();
const normalize=v=>String(v||"").replace(/[<>]/g," ").replace(/\s+/g," ").trim();
export function buildFruttiSourceCopy({hook,story,publicationHook="",titleCore="",title="",descriptionCore="",description=""}={}){
 const narrativeHook=normalize(hook).toLocaleUpperCase("es");
 const editorialHook=normalize(publicationHook||hook).toLocaleUpperCase("es");
 const premise=normalize(story);
 if(!twoWordHook.test(editorialHook))throw Error("FRUTTI_SOURCE_HOOK_MUST_HAVE_TWO_WORDS");
 if(premise.length<25)throw Error("FRUTTI_SOURCE_STORY_REQUIRED");
 // Explicit editorial copy is authored WITH the episode intent, never by analyzing
 // the rendered clip or extracting action from the generation prompt.
 const rawTitle=normalize(title);
 let fullTitle;
 if(rawTitle){
  if(!rawTitle.startsWith(editorialHook+": "))throw Error("FRUTTI_SOURCE_TITLE_HOOK_MISMATCH");
  fullTitle=removeTags(rawTitle);
 }else{
  const core=removeTags(titleCore);
  if(!core)throw Error("FRUTTI_SOURCE_TITLE_NOT_AUTHORED");
  fullTitle=editorialHook+": "+core;
 }
 const wholeTitle=fullTitle+" "+FRUTTI_TITLE_TAGS;
 if(wholeTitle.length>100||!/^[A-ZÁÉÍÓÚÜÑ0-9]+ [A-ZÁÉÍÓÚÜÑ0-9]+:\s+\S/u.test(wholeTitle)||/…|\.\.\./.test(wholeTitle))
  throw Error("FRUTTI_SOURCE_TITLE_FORMAT_INVALID");
 if(/\[[^\]]+\]|GANCHO CENTRAL/i.test(wholeTitle))throw Error("FRUTTI_SOURCE_TITLE_PLACEHOLDER");
 const prose=String(description||descriptionCore||"").trim().replace(/(?:\s*#(?:Shorts|ViralShorts|FruttiDrama)\b)+\s*$/gi,"").trim();
 if(prose.length<30||prose.length>3800)throw Error("FRUTTI_SOURCE_DESCRIPTION_NOT_AUTHORED");
 if(/\[[^\]]+\]|(?:one continuous scene|character reference sheets|9:16 vertical|no duplicates)/i.test(prose))
  throw Error("FRUTTI_SOURCE_DESCRIPTION_TECHNICAL_OR_PLACEHOLDER");
 const wholeDescription=prose+"\n\n"+FRUTTI_TITLE_TAGS;
 if(wholeDescription.length>4000)throw Error("FRUTTI_SOURCE_DESCRIPTION_TOO_LONG");
 return {title:wholeTitle,description:wholeDescription,hook:narrativeHook,publicationHook:editorialHook,story:premise,
  metadata_provenance:"creative_episode_source",schema:FRUTTI_CREATIVE_PACKAGE_SCHEMA};
}
export function selectFruttiSourceIdea(row,episodeSource){
 const source=episodeSource&&typeof episodeSource==="object"?episodeSource:null;
 if(!source||String(source.hook||"").trim()!==String(row?.hook||"").trim()||String(source.story||"").trim()!==String(row?.story||"").trim())
  throw Error("FRUTTI_SOURCE_IDEA_NOT_MATCHED: title and description must originate with the exact episode intent");
 return buildFruttiSourceCopy(source);
}
