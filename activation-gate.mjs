// Shared durable operator control for all publisher processes on a host.
// Absence, invalid JSON, stale schema or an explicit OFF state always means OFF.
import fs from 'node:fs';
export function centralGateOpen(){
  const file=String(process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE||'').trim();
  if(!file)return false;
  try{
    const x=JSON.parse(fs.readFileSync(file,'utf8'));
    return x?.schema===1&&x?.enabled===true&&x?.activated_by==='operator'
      &&typeof x?.activation_id==='string'&&/^[a-f0-9-]{36}$/.test(x.activation_id);
  }catch{return false}
}
// The OCI image starts with PUBLISHER_ENABLED=false, but can honor a later
// *explicit human click* only when both durable per-channel gates and the
// central gate have been opened. This is never a timed/background activation.
export function operatorGenerationEnvEnabled({operatorActivated=false,factoryEnabled=false}={}){
  const explicitEnv=String(process.env.PUBLISHER_ENABLED||'false').toLowerCase()==='true'
    ||String(process.env.PUBLISHER_ENABLE_AFTER_MANUAL_ACTIVATION||'false').toLowerCase()==='true';
  return explicitEnv&&operatorActivated===true&&factoryEnabled===true&&centralGateOpen();
}
export function assertCentralGate(){
  if(!centralGateOpen())throw new Error('PUBLISHER_GLOBAL_OPERATOR_PAUSE_ACTIVE');
}
