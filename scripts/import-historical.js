import fs from "node:fs/promises";
import { historicalRecord, importHistorical } from "../lib/historical.js";
import { closePool } from "../lib/db.js";
const args = process.argv.slice(2);
try {
  if (!args.includes("--source")) throw new Error("Use --source PATH [--apply]; default is a sanitised preview");
  const record = historicalRecord(await fs.readFile(args[args.indexOf("--source")+1]));
  console.log(JSON.stringify(args.includes("--apply") ? {sourceHash:record.sourceHash,inserted:await importHistorical(record)} : record,null,2));
} catch(e) { console.error(e instanceof SyntaxError ? "Invalid historical JSON" : e.message); process.exitCode=1; } finally { await closePool(); }
