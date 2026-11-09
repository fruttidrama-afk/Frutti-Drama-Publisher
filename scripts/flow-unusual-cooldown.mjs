// Publisher Factory protocol agreed with operator (Sept 23-25, 2026).
// Only for Flow's explicit generation rejection "Unusual Activity" + "not charged".
export const FLOW_NO_CHARGE_BACKOFF_MINUTES=Object.freeze([30,60,120,240,480,1440]);
export function flowNoChargeDelayMs(streak){
 const n=Math.max(1,Math.floor(Number(streak)||1));
 return FLOW_NO_CHARGE_BACKOFF_MINUTES[Math.min(n,FLOW_NO_CHARGE_BACKOFF_MINUTES.length)-1]*60000;
}
export function flowNoChargeDeadline(priorDeadlineMs,alertMs,streak){
 const base=Number(alertMs);
 if(!Number.isFinite(base)||base<=0)throw Error('FLOW_ALERT_TIMESTAMP_INVALID');
 return Math.max(Number(priorDeadlineMs)||0,base+flowNoChargeDelayMs(streak));
}
