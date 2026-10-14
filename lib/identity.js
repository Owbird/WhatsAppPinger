import crypto from "crypto";
import fs from "fs/promises";

// Keyed hashing prevents enumeration of the numbering plan from reversing identities.
const SECRET_PATH = process.env.IDENTITY_SECRET_PATH ?? new URL("../config/identity.secret",import.meta.url);

export async function identityMetadataAvailable() {
  try { return Boolean(await getSecret()); } catch { return false; }
}
async function getSecret() {
  const secret = process.env.IDENTITY_HMAC_SECRET ?? (await fs.readFile(SECRET_PATH, "utf8")).trim();
  if (secret.length < 32) throw new Error("Identity secret must contain at least 32 characters");
  return secret;
}

// Exclude the transport suffix from the identity hash.
function normalizeWid(wid) {
  return String(wid).split("@")[0];
}

export async function keyedHash(value) {
  const secret = await getSecret();
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

export async function hashIdentity(wid) {
  return keyedHash(normalizeWid(wid));
}

export async function verifyIdentity(account, wid) {
  if (!account.identityHash) {
    throw new Error("No identityHash on file for this account — run enrollment first.");
  }
  const actual = await hashIdentity(wid);
  if (actual !== account.identityHash) {
    throw new Error(
      "Identity mismatch: the logged-in session does not match the account this manifest entry was enrolled for. " +
      "Refusing to run — this would otherwise silently apply the experiment to the wrong account."
    );
  }
}
