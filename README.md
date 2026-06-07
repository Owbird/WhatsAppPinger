# WhatsAppPinger

> Finding Ghanaians on WhatsApp, politely.

A PoC that enumerates Ghanaian phone numbers against WhatsApp's registration API to determine which numbers are active on the platform.

Read the full write-up: [Finding Ghanaians on WhatsApp, Politely.](https://owbird.dev/blog/Trying-to-Find-All-Ghanaians-on-WhatsApp-Politely)

---

## ⚠️ Disclaimer

Yes, this is a privacy concern. Phone number enumeration is a known attack vector, it's how stalkers find targets, how spammers build lists, how phishing campaigns get seeded. WhatsApp is aware of this class of attack.

---

## How it works

Ghana's phone numbers follow a simple structure — a 3-digit network prefix and a 7-digit suffix. WhatsApp exposes an `isRegisteredUser()` method via `whatsapp-web.js` that returns whether a given number is on the platform.

This script iterates over all known Ghanaian network prefixes and checks each number in sequence, saving registered numbers to `numbers/registered.json` and checkpointing progress in `snapshot.json` so runs can be resumed.

**Prefixes checked:**
```
020, 050, 023, 024, 025, 053, 054, 055, 059, 026, 027, 056
```

**Total number space:** 12 prefixes × 10,000,000 suffixes = 120 million numbers.

A 30-minute sleep between checks keeps the account from getting banned. At that rate, a full sweep would take roughly 6,849 years. It's a PoC.

---

## Setup & usage

**Prerequisites**
- Node.js 18+
- A WhatsApp account to authenticate with

**Install dependencies**
```bash
npm install
```

**Initialize the snapshot file**
```bash
echo '{"prefixIndex": 0, "numberIndex": 0}' > snapshot.json
```

**Create the output directory**
```bash
mkdir -p numbers
```

**Run**
```bash
node index.js
```

On first run, a QR code will be displayed in the terminal. Scan it with WhatsApp to authenticate. Subsequent runs will reuse the saved session.

To resume from where you left off, just run again, the snapshot file handles the rest.

---

## Sample output

```
[+] [Thu, Jun 5, 2026, 10:22:01 AM] Starting WhatsApp Pinger...
[+] [Thu, Jun 5, 2026, 10:22:01 AM] Using snapshot {"prefixIndex":0,"numberIndex":0}
[+] [Thu, Jun 5, 2026, 10:22:04 AM] Client is ready!
[+] [Thu, Jun 5, 2026, 10:22:05 AM] Checking number 233200000000...
[+] [Thu, Jun 5, 2026, 10:22:06 AM] [❌] 233200000000 is not registered
[+] [Thu, Jun 5, 2026, 10:22:06 AM] Sleeping till next run...
[+] [Thu, Jun 5, 2026, 10:52:07 AM] Checking number 233200000001...
[+] [Thu, Jun 5, 2026, 10:52:08 AM] [✅] 233200000001 is registered
```

To count registered numbers at any point:
```bash
cat numbers/registered.json | jq .[] | wc -l
```
