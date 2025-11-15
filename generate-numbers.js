import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

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

const dirName = "numbers";

(async () => {
  if (!existsSync(dirName)) mkdirSync(dirName);

  for (const prefix of prefixes) {
    console.log(`Generating numbers for network ${prefix}...`);

    const numbers = [];

    for (let i = 0; i < 10_000_000; i++) {
      numbers.push(prefix + String(i).padStart(7, "0"));
    }

    console.log(`Saving ${prefix}.json ...`);

    writeFileSync(join(dirName, `${prefix}.json`), JSON.stringify(numbers));

    console.log(`Done: ${prefix}.json `);
  }

  console.log("ALL PREFIX FILES ARE DONE!");
})();
