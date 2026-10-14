import crypto from "crypto";
import fs from "fs/promises";

// Must be keyed: an unkeyed hash of a phone number is reversible by brute
// force over the numbering plan. The key lives outside the repo.
const SECRET_PATH = "./config/identity.secret";

async function getSecret() {
  try {
    return (await fs.readFile(SECRET_PATH, "utf8")).trim();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const secret = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  }
}

// wid looks like "233501234567@c.us"; hash the number alone.
function normalizeWid(wid) {
  return String(wid).split("@")[0];
}

// HMAC-SHA256 under the local secret. Shared with lib/network.js so IP
// addresses are hashed the same way phone numbers are.
export async function keyedHash(value) {
  const secret = await getSecret();
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

export async function hashIdentity(wid) {
  return keyedHash(normalizeWid(wid));
}

// Write-once: refuses to overwrite an existing hash.
export async function enrollIdentity(manifestEntry, wid) {
  if (manifestEntry.identityHash) {
    throw new Error("Account already has an identityHash set — this looks like a re-enrollment, not first enrollment. Clear it explicitly if intended.");
  }
  manifestEntry.identityHash = await hashIdentity(wid);
}

// Called on every run start, once client.info is populated. Throws rather
// than returning a bool so the result can't be ignored.
export async function verifyIdentity(manifestEntry, wid) {
  if (!manifestEntry.identityHash) {
    throw new Error("No identityHash on file for this account — run enrollment first.");
  }
  const actual = await hashIdentity(wid);
  if (actual !== manifestEntry.identityHash) {
    throw new Error(
      "Identity mismatch: the logged-in session does not match the account this manifest entry was enrolled for. " +
      "Refusing to run — this would otherwise silently apply the wrong arm's schedule to the wrong account."
    );
  }
}
