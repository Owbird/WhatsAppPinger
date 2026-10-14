// IP lookup, hosting classification and keyed hashing.
//
// Called at three points: enrollment, run start and halt. The raw address is
// held only long enough to hash it and hand it to the lookup; only the keyed
// hash and the extracted fields are ever returned for persistence.
import { IPINFO_TOKEN } from "./config.js";
import { keyedHash } from "./identity.js";

// Known cloud/hosting ASNs. Used only when the lookup service gives no
// classification of its own. Short by design; extend as needed.
export const HOSTING_ASNS = new Map([
  ["AS14061", "DigitalOcean"],
  ["AS16509", "Amazon AWS"],
  ["AS14618", "Amazon AWS"],
  ["AS15169", "Google Cloud"],
  ["AS396982", "Google Cloud"],
  ["AS8075", "Microsoft Azure"],
  ["AS9009", "M247"],
  ["AS24940", "Hetzner"],
  ["AS213230", "Hetzner"],
  ["AS63949", "Linode/Akamai"],
  ["AS20473", "Vultr/Choopa"],
  ["AS16276", "OVH"],
  ["AS12876", "Scaleway"],
  ["AS51167", "Contabo"],
  ["AS60068", "CDN77/Datacamp"],
  ["AS45102", "Alibaba Cloud"],
  ["AS31898", "Oracle Cloud"],
]);

const IPINFO_URL = "https://ipinfo.io/json";

// ipinfo returns org as "AS15169 Google LLC" on the free tier.
export function parseOrg(org) {
  const match = /^(AS\d+)\s+(.*)$/.exec(org ?? "");
  if (match) return { asn: match[1], org: match[2] };
  return { asn: null, org: org ?? null };
}

export function classifyHosting(data) {
  if (typeof data.is_hosting === "boolean") return { isHosting: data.is_hosting, source: "service" };
  if (typeof data.hosting === "boolean") return { isHosting: data.hosting, source: "service" };
  if (data.privacy && typeof data.privacy.hosting === "boolean") {
    return { isHosting: data.privacy.hosting, source: "service" };
  }
  const asn = data.asn?.asn ?? (typeof data.asn === "string" ? data.asn : null) ?? parseOrg(data.org).asn;
  return { isHosting: asn ? HOSTING_ASNS.has(asn) : null, source: "asn-list" };
}

export async function lookupSelf({ fetchImpl = globalThis.fetch, token = IPINFO_TOKEN } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const url = token ? `${IPINFO_URL}?token=${encodeURIComponent(token)}` : IPINFO_URL;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ip lookup failed: HTTP ${res.status}`);
  const data = await res.json();

  const parsed = parseOrg(data.org);
  const { isHosting, source } = classifyHosting(data);
  return {
    ip: data.ip ?? null,
    asn: data.asn?.asn ?? parsed.asn,
    org: data.asn?.name ?? parsed.org,
    country: data.country ?? null,
    isHosting,
    hostingSource: source,
  };
}

// Returns a row ready for network_observations. `runId` is null at enrollment.
export async function captureNetwork({ accountId, runId = null, point, lookupOpts } = {}) {
  const info = await lookupSelf(lookupOpts);
  if (!info.ip) throw new Error("ip lookup returned no address");
  return {
    account_id: accountId,
    run_id: runId,
    point,
    asn: info.asn,
    org: info.org,
    country: info.country,
    is_hosting: info.isHosting,
    hosting_source: info.hostingSource,
    ip_hash: await keyedHash(info.ip),
    observed_at: new Date().toISOString(),
  };
}
