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
    try{
      // flock forks the command; kill its whole private process group,
      // including the sleeping FD holder, to release kernel flock reliably.
      if(process.platform==='linux'&&prior.pid)process.kill(-prior.pid,'SIGTERM');
      else prior.kill('SIGTERM');
    }catch{try{prior.kill('SIGTERM')}catch{}}
  };
  const acquire=async()=>{
    if(!file)return false;
    if(owned())return false;  // nonreentrant; duplicate worker must wait
    try{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})}
    catch{return false}
    if(process.platform!=='linux')return false;
    return new Promise(resolve=>{
      let settled=false,buffer='';
      const job=spawn('flock',['-n','-E','73',file,'sh','-c',
        'printf "FLOW_MUTEX_READY\\n"; exec sleep 2147483647'],
        {detached:true,stdio:['ignore','pipe','pipe']});
      child=job;
      const timeout=setTimeout(()=>finish(false),acquireTimeoutMs);
      timeout.unref?.();
      function finish(ok){
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        if(!ok){if(child===job)release();else try{process.kill(-job.pid,'SIGTERM')}catch{}}
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
