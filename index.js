import qrcode from "qrcode-terminal";
import fs from "fs/promises";

import pkg from "whatsapp-web.js";

const { Client, LocalAuth } = pkg;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "main-session",
  }),
  puppeteer: {
    headless: false,
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

client.on("qr", (qr) => {
  console.log("Scan this QR:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  for (const prefix of prefixes) {

    for (let i = 0; i < 10_000_000; i++) {
      const number = `233${prefix.replace("0", "")}${String(i).padStart(7, "0")}`;

      try {
        const isRegistered = await client.isRegisteredUser(number);

        console.log(
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
        await sleep(1000*5);
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

console.log("[+] Starting WhatsApp Pinger...");
