import { IPINFO_TOKEN } from "./config.js";
import { keyedHash } from "./identity.js";

// Use ASN classification only when the service provides none.
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

// Parse the combined ASN and organisation field returned by ipinfo.
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

export async function captureNetwork({ accountId, runId = null, hostLabel = null, point, lookupOpts } = {}) {
  const info = await lookupSelf(lookupOpts);
  if (!info.ip) throw new Error("ip lookup returned no address");
  return {
    account_id: accountId,
    host_label: hostLabel,
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
