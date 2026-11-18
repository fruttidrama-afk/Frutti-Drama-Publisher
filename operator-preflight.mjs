// Must be the FIRST --import preload in every Publisher runtime entrypoint.
// Reject accidental deployments with weak/missing authentication material before
// runtime-init can create or migrate any persistent SQLite tables or Flow files.
const key=String(process.env.PUBLISHER_SESSION_SECRET||'').trim();
if(key.length<32||/^REPLACE_WITH_/i.test(key)){
  throw new Error('PUBLISHER_SESSION_SECRET_REQUIRED: configure a unique high-entropy secret before starting the runtime');
}
// Keep generation/publication deactivated by their independent central and
// durable per-channel gates. This module never opens either gate.
