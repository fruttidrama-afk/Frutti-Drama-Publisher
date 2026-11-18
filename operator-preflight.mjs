// Must be the FIRST --import preload in every Publisher runtime entrypoint.
// Reject accidental deployments with weak/missing authentication material before
// runtime-init can create or migrate any persistent SQLite tables or Flow files.
const key=String(process.env.PUBLISHER_SESSION_SECRET||'').trim();
if(key.length<32||/^REPLACE_WITH_/i.test(key)){
  throw new Error('PUBLISHER_SESSION_SECRET_REQUIRED: configure a unique high-entropy secret before starting the runtime');
}
// Setup links are authentication credentials, not configuration examples.
const setup=String(process.env.PUBLISHER_SETUP_TOKEN||'').trim();
if(setup&&(/^REPLACE_WITH_/i.test(setup)||setup.length<32)){
  throw new Error('PUBLISHER_SETUP_TOKEN_UNSAFE: use a separate random setup token or leave it unset after enrollment');
}
// A child Publisher must never load another show's persisted identities or
// accidentally use a generic fallback configuration after a redeployment.
const channel=String(process.env.PUBLISHER_CHANNEL_ID||'').trim();
if(channel){
  // Three publishers sharing a Flow account must have the same kernel-backed
  // lock volume; a missing path is not a valid production configuration.
  if(!String(process.env.PUBLISHER_GLOBAL_FLOW_LOCK_PATH||'').startsWith('/flow-lock/')){
    throw new Error('PUBLISHER_SHARED_FLOW_LOCK_REQUIRED');
  }
  const expected={'fruttidrama':'FruttiDrama','earth-in-10':'Earth in 10','dinnie':'Dinnie the Dinosaur'};
  if(!Object.hasOwn(expected,channel))throw new Error('PUBLISHER_UNKNOWN_CHANNEL_ID');
  let config;
  try{config=JSON.parse(String(process.env.PUBLISHER_CONFIG_JSON||''))}
  catch{throw new Error('PUBLISHER_CHANNEL_CONFIG_REQUIRED: private per-channel staging env is missing or malformed')}
  const normalize=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(normalize(config?.identity?.show_name)!==normalize(expected[channel])){
    throw new Error('PUBLISHER_CHANNEL_IDENTITY_MISMATCH: refusing to run a child under a different show name');
  }
}
// Keep generation/publication deactivated by their independent central and
// durable per-channel gates. This module never opens either gate.
