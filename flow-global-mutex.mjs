// Cross-container kernel-backed Flow mutex for Linux OCI bind mounts.
// An OS flock is released on process/container death; it is never reclaimed
// by an unsafe wall-clock timeout while a browser action might still be live.
// Must be used by ALL Google Flow workers sharing the same account.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function createFlowMutex(filePath,{acquireTimeoutMs=5000}={}){
  const file=String(filePath||'').trim();
  let child=null;
  const owned=()=>Boolean(child&&child.exitCode===null&&child.signalCode===null);
  const release=()=>{
    const prior=child;
    child=null;
    if(!prior)return;
    // The lock holder is a *single* no-fork process reading the parent's
    // stdin pipe. On normal release OR on sudden parent death, EOF closes
    // that reader and releases its OS flock without stale-time heuristics.
    try{prior.stdin?.end()}catch{}
    try{prior.kill('SIGTERM')}catch{}
  };
  const acquire=async()=>{
    if(!file)return false;
    if(owned())return false;  // nonreentrant; duplicate worker must wait
    try{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})}
    catch{return false}
    if(process.platform!=='linux')return false;
    return new Promise(resolve=>{
      let settled=false,buffer='';
      // flock -F execs the holder WITHOUT forking; cat blocks on stdin.
      // Parent death closes the pipe, so a crash never leaves an orphan lock.
      const job=spawn('flock',['-F','-n','-E','73',file,'sh','-c',
        'printf "FLOW_MUTEX_READY\\n"; exec cat >/dev/null'],
        {stdio:['pipe','pipe','pipe']});
      child=job;
      const timeout=setTimeout(()=>finish(false),acquireTimeoutMs);
      timeout.unref?.();
      function finish(ok){
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        if(!ok){if(child===job)release();else try{job.kill('SIGTERM')}catch{}}
        resolve(ok);
      }
      job.on('error',()=>finish(false));
      job.on('exit',()=>finish(false));
      job.stdout.on('data',bytes=>{
        buffer+=String(bytes);
        if(buffer.includes('FLOW_MUTEX_READY')){
          // Never report ownership if another event already exited/failed.
          finish(job.exitCode===null&&job.signalCode===null);
        }
      });
    });
  };
  return {acquire,release,owned};
}
