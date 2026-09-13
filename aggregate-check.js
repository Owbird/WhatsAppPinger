// Checks each candidate number from a Phase A sample (sample-frame.js)
// against WhatsApp's isRegisteredUser(), then discards the number
// immediately after tallying it. The only thing ever written to disk is a
// per-prefix counter: { prefix, sampled, registered }.
//
// Usage:
//   node aggregate-check.js
//   node aggregate-check.js --in sample.json --out summary.json --interval 1800

import fs from "fs/promises";

import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import chalk from "chalk";
const { Client, LocalAuth } = pkg;

const DEFAULT_IN = "./sample.json"; // produced by sample-frame.js
const DEFAULT_OUT = "./summary.json"; // aggregate-only
const DEFAULT_INTERVAL = 1800; // seconds between checks 

function log(value) {
  const now = new Date().toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  console.log(chalk.greenBright(`[+] [${now}]`, value));
}

async function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Load the existing per-prefix summary, if any. Returns a Map keyed by
 * prefix so counts can be updated in place.
 */
async function loadSummary(path) {
  try {
    const raw = JSON.parse(await fs.readFile(path, "utf8"));
    return new Map(raw.map((row) => [row.prefix, row]));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return new Map();
  }
}

async function saveSummary(path, summary) {
  const rows = [...summary.values()];
  await fs.writeFile(path, JSON.stringify(rows, null, 2), "utf8");
}

/**
 * Group the sample by prefix, preserving order, without ever needing to
 * keep the full flat list plus a parallel "already processed" set — each
 * prefix's queue is just the tail past however many have already been
 * tallied for it.
 */
function groupByPrefix(sample) {
  const groups = new Map();
  for (const { prefix, number } of sample) {
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(number);
  }
  return groups;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const sample = JSON.parse(await fs.readFile(args.in, "utf8"));
  const groups = groupByPrefix(sample);
  const summary = await loadSummary(args.out);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: "main-session" }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  client.on("qr", (qr) => {
    log("Scan this QR:");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    log("Client is ready!");

    for (const [prefix, numbers] of groups) {
      const row = summary.get(prefix) ?? {
        prefix,
        sampled: 0,
        registered: 0,
      };
      summary.set(prefix, row);

      for (let i = row.sampled; i < numbers.length; i++) {
        const number = numbers[i];

        let isRegistered;
        try {
          isRegistered = await client.isRegisteredUser(number);
        } catch (error) {
          console.error(error);
          continue; // don't advance the cursor on a failed check
        }

        row.sampled += 1;
        if (isRegistered) row.registered += 1;

        await saveSummary(args.out, summary);

        log(
          `[${prefix}] checked ${row.sampled}/${numbers.length} (registered so far: ${row.registered})`,
        );
        await sleep(args.interval);
      }
    }

    log(`Done. Summary written to ${args.out}`);
    await client.destroy();
  });

  client.initialize();
}

function parseArgs(argv) {
  const args = {
    in: DEFAULT_IN,
    out: DEFAULT_OUT,
    interval: DEFAULT_INTERVAL,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in") args.in = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--interval") args.interval = Number(argv[++i]);
  }

  return args;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
