import crypto from "node:crypto";
import { tx } from "./db.js";
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const timestamp = x => typeof x === "string" && /Z$|[+-]\d\d:\d\d$/.test(x) && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
// Import only allowlisted aggregates; unavailable fields stay null.
export function historicalRecord(bytes) {
  const source = JSON.parse(bytes.toString("utf8"));
  if (!source.rq1 || typeof source.rq1 !== "object") throw new Error("Expected original rq1 state");
  const tiers = {};
  for (const id of ["T0","T1","T2","T3","T4"]) {
    const raw = source.rq1.latency?.[id];
    const latency = raw ? Object.fromEntries(["n","min","max","sum","sumSq"].map(k=>[k,typeof raw[k] === "number" && Number.isFinite(raw[k]) && raw[k]>=0 ? raw[k] : null])) : null;
    if (latency) latency.segments = Array.isArray(raw.segments) ? raw.segments.slice(0,10).map(s=>({n:count(s.n),sum:typeof s.sum === "number" && Number.isFinite(s.sum) && s.sum>=0?s.sum:null})) : null;
    tiers[id] = {status:["complete","halted"].includes(source.rq1.tierStatus?.[id]) ? source.rq1.tierStatus[id] : null,checkpoint:count(source.rq1.tierProgress?.[id]),recoveryCheckpoint:count(source.rq1.tierProgress?.[`${id}-recovery`]),latency};
  }
  const signals = new Set(["disconnect","auth_failure","error"]);
  const events = (Array.isArray(source.events) ? source.events : []).filter(e => /^T[0-4]$/.test(e.tier) && signals.has(e.signal)).map(e=>({tier:e.tier,phase:["run","recovery"].includes(e.phase)?e.phase:null,index:count(e.index),signal:e.signal,timestamp:timestamp(e.timestamp)}));
  return { sourceHash:crypto.createHash("sha256").update(bytes).digest("hex"), provenance:{format:"original-rq1-state",sourceCommit:"4c3f38dfed110c42d69159efd9a7eb263065e8be"},dataset:"historical",observations:{tiers,events,cumulativeOperations:null,outcome:null,host:null,startedAt:null,endedAt:null} };
}
export async function importHistorical(record) {
  return tx(async c => {
    const result = await c.query(`insert into research_archive.historical_imports(source_hash,provenance,observations) values($1,$2,$3) on conflict(source_hash) do nothing returning source_hash`,[record.sourceHash,record.provenance,record.observations]);
    if (result.rows.length) await c.query(`insert into event_log(event_key,account_id,kind,payload) values($1,$2,'historical_import',$3)`,[`historical|${record.sourceHash}`,`historical-${record.sourceHash.slice(0,12)}`,record.provenance]);
    return Boolean(result.rows.length);
  });
}
