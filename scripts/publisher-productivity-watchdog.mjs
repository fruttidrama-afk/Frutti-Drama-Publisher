import fs from "node:fs";

const URL = "https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-free-runtime/health";
const MAX_GENERATION_GAP_HOURS = 36;
const now = new Date();
const summary = [
  "# Publisher Factory — unattended productivity watchdog",
  "",
  "Checked: " + now.toISOString(),
  "",
  "This check is read-only. A green scheduler or a valid lease does **not** prove that a video was generated or published.",
  ""
];
let failed = false;
try {
  const response = await fetch(URL, {signal: AbortSignal.timeout(15000), headers: {"accept":"application/json","cache-control":"no-cache"}});
  if (!response.ok) throw Error("Health endpoint returned HTTP " + response.status);
  const body = await response.json();
  if (body.ok !== true || !Array.isArray(body.publishers)) throw Error("Invalid health response");
  if (body.publishers.length !== 3) {
    summary.push("**WARNING**: expected three publishers, found " + body.publishers.length + ".");
    failed = true;
  }
  summary.push("| Publisher | Migration | Last confirmed generation (UTC) | Last confirmed publication (UTC) | Health |");
  summary.push("|---|---|---|---|---|");
  for (const p of body.publishers) {
    const name = String(p.name || p.id || "unknown").replace(/[|\r\n]/g," ");
    const migration = String(p.migration_state || "unknown").replace(/[|\r\n]/g," ");
    const generation = p.last_generation_at ? new Date(p.last_generation_at) : null;
    const publication = p.last_publication_at ? new Date(p.last_publication_at) : null;
    let status = "OK";
    if (p.enabled !== true) {
      status = "DISABLED";
      failed = true;
    } else if (migration !== "ready") {
      status = "MIGRATION_INCOMPLETE";
      failed = true;
    } else if (!generation || !Number.isFinite(generation.getTime())) {
      status = "NO_CONFIRMED_GENERATION";
      failed = true;
    } else if (now.getTime() - generation.getTime() > MAX_GENERATION_GAP_HOURS * 3600000) {
      status = "GENERATION_STALE";
      failed = true;
    }
    const fmt = date => date && Number.isFinite(date.getTime()) ? date.toISOString() : "none";
    summary.push("| " + name + " | " + migration + " | " + fmt(generation) + " | " + fmt(publication) + " | **" + status + "** |");
  }
  summary.push("");
  summary.push("Publication timestamps are informational: zero approved stock or human Review can legitimately prevent a publication. Verify stock, remote platform identity and due-slot separately.");
  summary.push("Do not re-submit a Google Flow prompt after an ambiguous timeout. Reconcile the exact Flow asset ID first.");
} catch (error) {
  failed = true;
  summary.push("**HEALTH ENDPOINT UNAVAILABLE**: " + String(error?.message || error).slice(0,240));
}
const report = summary.join("\n") + "\n";
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
if (failed) {
  console.error("PUBLISHER_PRODUCTIVITY_FAILURE: scheduler liveness is not production success");
  process.exitCode = 1;
}
