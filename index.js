import qrcode from "qrcode-terminal";
import fs from "fs/promises";

import pkg from "whatsapp-web.js";
import chalk from "chalk";
const { Client, LocalAuth } = pkg;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "main-session",
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
  },
});

const prefixes = [
  "020",
  "050",
  "023",
  "024",
  "025",
  "053",
  "054",
  "055",
  "059",
  "026",
  "027",
  "056",
];

const snapshot = JSON.parse(await fs.readFile("./snapshot.json", "utf8"));

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

client.on("qr", (qr) => {
  log("Scan this QR:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  log("Client is ready!");
  for (let i = snapshot.prefixIndex; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    for (let j = snapshot.numberIndex; j < 10_000_000; j++) {
      const number = `233${prefix.replace("0", "")}${String(j).padStart(7, "0")}`;

      try {
        log(`Checking number ${number}...`);
        const isRegistered = await client.isRegisteredUser(number);

        log(
          `[${isRegistered ? "✅" : "❌"}] ${number} is ${isRegistered ? "registered" : "not registered"}`,
        );

        if (isRegistered) {
          const filePath = "numbers/registered.json";
          try {
            let numbers = [];
            try {
              const data = await fs.readFile(filePath, "utf8");
              numbers = JSON.parse(data);
            } catch (readError) {
              if (readError.code !== "ENOENT") {
                throw readError;
              }
            }

            if (!numbers.includes(number)) {
              numbers.push(number);
              await fs.writeFile(
                filePath,
                JSON.stringify(numbers, null, 2),
                "utf8",
              );
            }
          } catch (fileError) {
            console.error(`Error updating ${filePath}:`, fileError);
          }
        }

        await fs.writeFile(
          "snapshot.json",
          JSON.stringify({ prefixIndex: i, numberIndex: j }, null, 2),
          "utf8",
        );

        log(`Sleeping till next run...`);
        await sleep(1800);
      } catch (error) {
        console.log(error);
      }
    }
  }
});

client.on("message", (msg) => {
  if (msg.body === "!ping") {
    msg.reply("pong");
  }
});

client.initialize();

log("Starting WhatsApp Pinger...");
log(`Using snapshot ${JSON.stringify(snapshot)}`);
