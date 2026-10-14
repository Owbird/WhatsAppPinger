import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOrg, classifyHosting, HOSTING_ASNS } from "../lib/network.js";

test("org string is split into ASN and name", () => {
  assert.deepEqual(parseOrg("AS15169 Google LLC"), { asn: "AS15169", org: "Google LLC" });
  assert.deepEqual(parseOrg(null), { asn: null, org: null });
});

test("the service classification wins when present", () => {
  assert.deepEqual(classifyHosting({ hosting: true, org: "AS1 Unknown" }), { isHosting: true, source: "service" });
  assert.deepEqual(classifyHosting({ privacy: { hosting: false }, org: "AS15169 Google LLC" }), {
    isHosting: false,
    source: "service",
  });
});

test("known hosting ASNs are the fallback", () => {
  const known = [...HOSTING_ASNS.keys()][0];
  assert.deepEqual(classifyHosting({ org: `${known} Some Cloud` }), { isHosting: true, source: "asn-list" });
  assert.deepEqual(classifyHosting({ org: "AS999999 Some ISP" }), { isHosting: false, source: "asn-list" });
});
