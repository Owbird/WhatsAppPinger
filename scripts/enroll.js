#!/usr/bin/env node

import os from "os";
import fs from "fs/promises";
import path from "path";
import readline from "readline";
import { pathToFileURL } from "url";
import chalk from "chalk";

import { hashIdentity } from "../lib/identity.js";
import { captureNetwork } from "../lib/network.js";
import { listAccounts, enrollAccount, findAccountByIdentityHash } from "../lib/repo.js";
import { closePool } from "../lib/db.js";
import { HOSTS, resolveHostLabel } from "../lib/config.js";

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

export function nextFreeId(accounts = []) {
  const nums = accounts
    .map((a) => /^A(\d+)$/.exec(a.id ?? a))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `A${String(next).padStart(2, "0")}`;
}

// Validate IDs before using them as directory names and LocalAuth client IDs.
export function validateAccountId(id, accounts = []) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(id)) {
    return "2-16 chars: letters, digits, - or _, starting with a letter";
  }
  const taken = accounts.map((a) => a.id ?? a).find((k) => k.toLowerCase() === id.toLowerCase());
  return taken ? `${taken} is already enrolled` : null;
}

export function validateCount(s) {
  if (!/^\d+$/.test(s)) return "Enter a whole number (0 or more)";
  if (Number(s) > 1_000_000) return "That looks too large";
  return null;
}

export function lastDigits(wid, n = 2) {
  return String(wid).split("@")[0].replace(/\D/g, "").slice(-n);
}

export function buildEntry({ covariates, hostname, ipClass, environment, now = new Date() }) {
  return {
    covariates,
    ipClass,
    environment: { ...environment, hostname },
    enrolledAt: now.toISOString(),
  };
}

// Move up, clear and redraw the terminal region.
function createBlock() {
  let lines = 0;
  return {
    render(newLines) {
      if (lines > 1) process.stdout.write(`\x1b[${lines - 1}A`);
      process.stdout.write("\r\x1b[0J" + newLines.join("\n"));
      lines = newLines.length;
    },
    finish(line) {
      this.render([line]);
      process.stdout.write("\n");
      lines = 0;
    },
  };
}

function suspendInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

// Disable raw mode before QR authentication so Ctrl+C produces SIGINT.
function interact(setup) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    const settle = (fn) => (value) => {
      stdin.off("keypress", handler);
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle(reject);

    const inner = setup(ok);
    const handler = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        process.stdout.write("\n");
        fail(new Cancelled());
        return;
      }
      inner(str, key);
    };
    stdin.on("keypress", handler);
  });
}

const isEnter = (key) => key.name === "return" || key.name === "enter";

function askText({ label, hint = "", initial = "", validate = () => null }) {
  const block = createBlock();
  let value = initial;
  let error = "";
  const draw = () =>
    block.render([
      `${chalk.cyan("?")} ${chalk.bold(label)}${hint ? " " + chalk.dim(`(${hint})`) : ""} ${value}${chalk.inverse(" ")}`,
      error ? chalk.red(`  ✖ ${error}`) : chalk.dim("  enter to confirm · ctrl+c to cancel"),
    ]);

  return interact((ok) => {
    draw();
    return (str, key) => {
      if (isEnter(key)) {
        const v = value.trim();
        const err = validate(v);
        if (err) {
          error = err;
          draw();
          return;
        }
        block.finish(`${chalk.green("✔")} ${chalk.bold(label)} ${chalk.cyan(v)}`);
        ok(v);
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
        error = "";
        draw();
      } else if (str && str.length === 1 && str >= " " && !key.ctrl && !key.meta) {
        value += str;
        error = "";
        draw();
      }
    };
  });
}

function askSelect({ label, options, initialIndex = 0 }) {
  const block = createBlock();
  let idx = initialIndex;
  const draw = () =>
    block.render([
      `${chalk.cyan("?")} ${chalk.bold(label)}`,
      ...options.map((o, i) =>
        i === idx
          ? `  ${chalk.cyan("❯")} ${chalk.cyan.bold(o.label)}${o.hint ? chalk.dim("  " + o.hint) : ""}`
          : `    ${o.label}`
      ),
      chalk.dim("  ↑/↓ to move · enter to select · ctrl+c to cancel"),
    ]);

  return interact((ok) => {
    draw();
    return (str, key) => {
      if (key.name === "up" || str === "k") {
        idx = (idx - 1 + options.length) % options.length;
        draw();
      } else if (key.name === "down" || str === "j") {
        idx = (idx + 1) % options.length;
        draw();
      } else if (isEnter(key)) {
        block.finish(`${chalk.green("✔")} ${chalk.bold(label)} ${chalk.cyan(options[idx].label)}`);
        ok(options[idx].value);
      }
    };
  });
}

function askConfirm({ label, initial = true, note = "" }) {
  const block = createBlock();
  const draw = () =>
    block.render([
      `${chalk.cyan("?")} ${chalk.bold(label)} ${chalk.dim(initial ? "(Y/n)" : "(y/N)")}`,
      ...(note ? [chalk.dim(`  ${note}`)] : []),
    ]);
  const answer = (ok, value) => {
    block.finish(`${chalk.green("✔")} ${chalk.bold(label)} ${chalk.cyan(value ? "Yes" : "No")}`);
    ok(value);
  };

  return interact((ok) => {
    draw();
    return (str, key) => {
      if (str === "y" || str === "Y") answer(ok, true);
      else if (str === "n" || str === "N") answer(ok, false);
      else if (isEnter(key)) answer(ok, initial);
    };
  });
}

function banner() {
  const text = "Enroll a study account";
  const w = 48;
  console.log(chalk.cyan(`╭${"─".repeat(w)}╮`));
  console.log(chalk.cyan("│") + chalk.bold(`  ${text}`.padEnd(w)) + chalk.cyan("│"));
  console.log(chalk.cyan("│") + chalk.dim("  no workload is run · one experiment across hosts".padEnd(w)) + chalk.cyan("│"));
  console.log(chalk.cyan(`╰${"─".repeat(w)}╯`));
}

function heading(n, total, text) {
  console.log(`\n${chalk.bold.cyan(`Step ${n} of ${total}`)} ${chalk.dim("·")} ${chalk.bold(text)}\n`);
}

function summary(rows) {
  const pad = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    console.log(`  ${chalk.dim(k.padEnd(pad))}  ${v}`);
  }
}

const SIM_TYPES = [
  { label: "Prepaid", value: "prepaid" },
  { label: "Postpaid", value: "postpaid" },
  { label: "eSIM", value: "esim" },
  { label: "Other", value: "other" },
];

const ACCOUNT_CLASSES = [
  { label: "Personal", value: "personal", hint: "matches the primary run" },
  { label: "Business", value: "business", hint: "the pilot's confound" },
];

const NETWORKS = [
  { label: "Home broadband", value: "home-broadband" },
  { label: "Mobile hotspot", value: "mobile-hotspot" },
  { label: "Campus network", value: "campus" },
  { label: "Data-centre / VPS", value: "datacentre" },
  { label: "Other", value: "other" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINK_TIMEOUT_MS = 5 * 60_000;

async function collectEnvironment(client) {
  let whatsappWebJs = null;
  try {
    const pj = await fs.readFile(path.resolve("node_modules/whatsapp-web.js/package.json"), "utf8");
    whatsappWebJs = JSON.parse(pj).version ?? null;
  } catch {}
  let wwebVersion = null;
  try {
    wwebVersion = client ? await client.getWWebVersion() : "dry-run";
  } catch {}
  return { node: process.version, platform: `${os.platform()}-${os.arch()}`, whatsappWebJs, wwebVersion };
}

async function linkPhone({ accountId, dataDir, state }) {
  const [{ default: pkg }, { default: qrcode }] = await Promise.all([
    import("whatsapp-web.js"),
    import("qrcode-terminal"),
  ]);
  const { Client, LocalAuth } = pkg;

  // Match the measurement adapter's LocalAuth path to reuse this session.
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: dataDir }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });
  state.client = client;

  const view = createBlock();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out after 5 minutes waiting for the QR scan.")),
      LINK_TIMEOUT_MS
    );
    const fail = (err) => {
      clearTimeout(timer);
      process.stdout.write("\n");
      reject(err);
    };

    client.on("qr", (qr) =>
      qrcode.generate(qr, { small: true }, (art) =>
        view.render([
          chalk.dim("Open WhatsApp › Settings › Linked devices › Link a device, then scan:"),
          ...art.trimEnd().split("\n"),
          chalk.dim("The code refreshes itself. ctrl+c to cancel."),
        ])
      )
    );
    client.on("authenticated", () => view.render([chalk.dim("Authenticated — loading WhatsApp Web…")]));
    client.on("loading_screen", (pct) => view.render([chalk.dim(`Loading WhatsApp Web… ${pct}%`)]));
    client.on("auth_failure", (m) => fail(new Error(`Authentication failed: ${m}`)));
    client.on("disconnected", (r) => fail(new Error(`Disconnected while linking: ${r}`)));

    client.once("ready", async () => {
      clearTimeout(timer);
      view.finish(`${chalk.green("✔")} Phone linked`);
      resolve({
        wid: client.info.wid._serialized,
        environment: await collectEnvironment(client),
      });
    });

    client.initialize().catch(fail);
  });
}

async function abort(state) {
  if (state.client) {
    try {
      await state.client.destroy();
    } catch {}
    state.client = null;
  }
  if (state.sessionDir && !state.committed) {
    await fs.rm(state.sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    state.sessionDir = null;
  }
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    dataDir: get("--data-dir", "./data"),
    host: get("--host", null),
    dryRun: argv.includes("--dry-run"),
    fakeWid: get("--fake-wid", null),
  };
}

async function loadAccounts(dryRun) {
  if (dryRun) return [];
  let accounts;
  try {
    accounts = await listAccounts();
  } catch (error) {
    throw new Error(`Could not reach the database (${error.message}). Is DATABASE_URL set in .env?`);
  }
  if (accounts.length === 0) {
    const start = await askConfirm({ label: "No accounts in the database yet. Start enrolling?", note: "Postgres is connected" });
    if (!start) throw new Cancelled();
  }
  return accounts;
}

async function run(args, state) {
  const TOTAL = 3;
  banner();

  const hostLabel = resolveHostLabel(args.host);

  heading(1, TOTAL, "Account details");
  const accounts = await loadAccounts(args.dryRun);

  const accountId = await askText({
    label: "Account ID",
    initial: nextFreeId(accounts),
    validate: (v) => validateAccountId(v, accounts),
  });
  const ageDays = Number(
    await askText({ label: "Account age in days", hint: "an estimate is fine", validate: validateCount })
  );
  const simType = await askSelect({ label: "SIM type", options: SIM_TYPES });
  const contactCount = Number(
    await askText({ label: "Number of contacts", hint: "approximate", validate: validateCount })
  );

  let accountClass;
  for (;;) {
    accountClass = await askSelect({ label: "Account class", options: ACCOUNT_CLASSES });
    if (accountClass !== "business") break;
    const proceed = await askConfirm({
      label: "Enroll a Business account anyway?",
      initial: false,
      note: "Business accounts were the confound that voided the pilot.",
    });
    if (proceed) break;
  }

  const ipClass = await askSelect({ label: "Network this account will run from", options: NETWORKS });
  const hostname = await askText({
    label: "Host machine",
    initial: os.hostname(),
    validate: (v) => (v ? null : "Cannot be empty"),
  });

  heading(2, TOTAL, "Review");
  summary([
    ["Account ID", chalk.cyan.bold(accountId)],
    ["Host label", `${hostLabel} ${chalk.dim(`(one of ${HOSTS.join(", ")})`)}`],
    ["Account age", `${ageDays} days`],
    ["SIM", simType],
    ["Contacts", String(contactCount)],
    ["Class", accountClass],
    ["Network", ipClass],
    ["Hostname", hostname],
    ["Experiment", chalk.dim("canonical configuration; no assignment needed")],
  ]);
  console.log();
  if (!(await askConfirm({ label: "Link a phone to this account now?" }))) throw new Cancelled();

  heading(3, TOTAL, "Link the phone");

  let wid;
  let environment;
  if (args.dryRun) {
    const view = createBlock();
    view.render([chalk.dim("Dry run — simulating a scan…")]);
    await sleep(600);
    view.finish(`${chalk.green("✔")} Phone linked ${chalk.dim("(simulated)")}`);
    wid = args.fakeWid;
    environment = await collectEnvironment(null);
  } else {
    const sessionDir = path.join(args.dataDir, `session-${accountId}`);
    const exists = await fs.access(sessionDir).then(() => true, () => false);
    if (exists) {
      throw new Error(`A session directory already exists at ${sessionDir}. Remove it, or choose a different ID.`);
    }
    state.sessionDir = sessionDir;
    suspendInput(); // so Ctrl+C is a normal SIGINT while we wait for the scan
    ({ wid, environment } = await linkPhone({ accountId, dataDir: args.dataDir, state }));
  }

  const hash = await hashIdentity(wid);

  if (!args.dryRun) {
    const early = await findAccountByIdentityHash(hash);
    if (early) throw new Error(`This phone number is already enrolled as ${early}. One phone, one account ID.`);
  }

  const digits = lastDigits(wid, 2);
  console.log(`\n  Linked number ends in ${chalk.bold.yellow("••" + digits)}\n`);
  const right = await askConfirm({
    label: `Is that the phone you meant to enroll as ${accountId}?`,
    initial: false,
    note: "Press y to confirm — Enter alone counts as No.",
  });
  if (!right) throw new Error("Wrong phone — nothing was enrolled. Run it again and scan with the right one.");

  const entry = buildEntry({
    covariates: { ageDays, simType, contactCount, businessAccount: accountClass === "business" },
    hostname,
    ipClass,
    environment,
  });

  if (args.dryRun) {
    const preview = { ...entry, hostLabel, identityHash: `${hash.slice(0, 12)}…` };
    console.log(`\n${chalk.yellow("Dry run")} — nothing written. Account that would be saved as ${chalk.bold(accountId)}:\n`);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  // Require the network observation before writing enrollment.
  let networkObs = null;
  try {
    networkObs = await captureNetwork({ accountId, hostLabel, point: "enrollment" });
  } catch (error) {
    throw new Error(`Enrollment network lookup failed (${error.message}). Nothing was written.`);
  }

  await enrollAccount({
    id: accountId,
    hostLabel,
    covariates: entry.covariates,
    environment: entry.environment,
    ipClass: entry.ipClass,
    identityHash: hash,
    networkObs,
  });
  state.committed = true;
  try {
    await state.client.destroy(); // keeps the session on disk for study.js
  } catch {}
  state.client = null;

  console.log(`\n${chalk.green("✔")} ${chalk.bold(accountId)} enrolled`);
  console.log(chalk.dim(`  postgres  account row + enrollment network observation`));
  console.log(chalk.dim(`  session   ${path.join(args.dataDir, `session-${accountId}`)}`));
  console.log(chalk.dim("  identity  keyed hash stored; the number itself is not\n"));
  console.log("Validate the enrolled account on its assigned host with study.js --dry-run.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !process.argv.includes("--authorised-authentication")) throw new Error("Enrollment authentication requires --authorised-authentication; no workload is started");

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("enroll.js is interactive and needs a terminal.");
    process.exitCode = 1;
    return;
  }
  if (args.dryRun && !args.fakeWid) {
    console.error("--dry-run needs --fake-wid, using a synthetic test identifier");
    process.exitCode = 1;
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  const state = { client: null, sessionDir: null, committed: false };

  process.once("SIGINT", async () => {
    console.log(chalk.dim("\nCancelled — cleaning up…"));
    await abort(state);
    await closePool();
    process.exit(130);
  });

  try {
    await run(args, state);
  } catch (error) {
    await abort(state);
    if (error instanceof Cancelled) {
      console.log(chalk.dim("Cancelled — nothing was written."));
      process.exitCode = 130;
    } else {
      console.error(`\n${chalk.red("✖")} ${error.message}`);
      console.error(chalk.dim("Nothing was written."));
      process.exitCode = 1;
    }
  } finally {
    suspendInput();
    await closePool();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().then(() => process.exit(process.exitCode ?? 0));
}
