// Explicitly trigger ONE read-only cold-restore test after a successful
// owner-initiated Google Flow login. Requires ephemeral GITHUB_TOKEN with
// actions:write; no passwords, cookies, Google API traffic or video submissions.
const key=String(process.env.TARGET_KEY||'').trim();
if(!['frutti','earth','dinnie'].includes(key))throw Error('FLOW_TARGET_INVALID');
const token=String(process.env.GH_COLD_RESTORE_DISPATCH_TOKEN||'');
if(!token)throw Error('GITHUB_ACTIONS_TOKEN_MISSING');
const url='https://api.github.com/repos/fruttidrama-afk/Frutti-Drama-Publisher/actions/workflows/flow-auth-cold-restore.yml/dispatches';
const res=await fetch(url,{method:'POST',headers:{
 'authorization':'Bearer '+token,'accept':'application/vnd.github+json',
 'x-github-api-version':'2022-11-28','content-type':'application/json'
},body:JSON.stringify({ref:'main',inputs:{publisher:key}})});
if(res.status!==204)throw Error('COLD_RESTORE_DISPATCH_FAILED_HTTP_'+res.status);
console.log('COLD_RESTORE_READ_ONLY_DISPATCH_ACCEPTED',key);
