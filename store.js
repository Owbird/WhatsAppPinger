import fs from "fs/promises";

export const emptyStore = () => ({
  rq2: { done: false, sample: null, rows: [] },
  rq1: { tierStatus: {}, tierProgress: {} }, // tierProgress: query count checkpoint for a tier still in flight
  events: [], // shared halt/recovery log for both rq2 and rq1, tagged by scope
});

export async function loadStore(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return emptyStore();
  }
}

export async function saveStore(path, store) {
  await fs.writeFile(path, JSON.stringify(store, null, 2), "utf8");
}
