// Clock offset at run start. A real SNTP query over UDP where the network
// allows it, falling back to the Date header of an HTTPS request. Stored so a
// skewed host clock can be accounted for after the fact.
import dgram from "dgram";

const NTP_EPOCH_OFFSET_S = 2_208_988_800;

export function sntpOffset(host = "pool.ntp.org", timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
    const t0 = Date.now();

    const finish = (error, value) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("sntp timeout")), timeoutMs);

    socket.once("error", (error) => finish(error));
    socket.once("message", (message) => {
      const seconds = message.readUInt32BE(40);
      const fraction = message.readUInt32BE(44);
      const t3 = Date.now();
      const serverMs = (seconds - NTP_EPOCH_OFFSET_S) * 1_000 + (fraction / 2 ** 32) * 1_000;
      finish(null, Math.round(serverMs - (t0 + t3) / 2));
    });
    socket.send(packet, 123, host);
  });
}

export async function measureClockOffset({ fetchImpl = globalThis.fetch } = {}) {
  try {
    return { offsetMs: await sntpOffset(), source: "sntp" };
  } catch {
    // fall through
  }
  try {
    if (typeof fetchImpl === "function") {
      const res = await fetchImpl("https://www.google.com", { method: "HEAD" });
      const date = res.headers?.get?.("date");
      if (date) return { offsetMs: Date.parse(date) - Date.now(), source: "http-date" };
    }
  } catch {
    // fall through
  }
  return { offsetMs: null, source: null };
}
