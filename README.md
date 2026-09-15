# WhatsAppPinger

> Do WhatsApp's contact-enumeration defenses hold up against ordinary browser automation?

The measurement harness behind an empirical study of WhatsApp's post-2025
anti-enumeration defenses. It drives a real WhatsApp Web session through
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) and pushes
contact-discovery traffic at escalating workload to observe how — and at what
volume — the platform's defenses respond.

Read the original write-up: [Finding Ghanaians on WhatsApp, Politely.](https://owbird.dev/blog/Trying-to-Find-All-Ghanaians-on-WhatsApp-Politely)

---

## ⚠️ Disclaimer

Phone-number enumeration is a known privacy attack vector — it's how stalkers
find targets, how spammers build lists, how phishing campaigns get seeded. This
harness exists to *measure the defenses against it*, not to build a list of
anyone. It deliberately records nothing about the numbers it queries (see
[What it records](#what-it-records)).

---

## What it measures

The study asks a single research question:

> **RQ1** — Do WhatsApp's contact-enumeration defenses generalize across client
> interfaces, specifically to browser-based client automation?
>
> - **RQ1a (qualitative)** — Which categories of defensive response are
>   observable (no response, latency change, soft throttling, temporary
>   restriction, permanent restriction)?
> - **RQ1b (quantitative)** — At which workload tier(s) does each category first
>   appear, and is the transition sharp or gradual?

Each query calls `isRegisteredUser()` on a candidate number, but **the
registered / not-registered answer is thrown away**. What's observed per query
is whether the query got through and whether the account stayed healthy — i.e.
the *defense's* reaction, not the number's status. The point is the platform's
behavior, not who is on WhatsApp.

## Ghana as sampling context

Candidate numbers are drawn from Ghana's twelve mobile numbering prefixes
(a random prefix + a random 7-digit suffix):

```
020, 050, 023, 024, 025, 053, 054, 055, 059, 026, 027, 056
```

Ghana here only fixes *where the query traffic comes from* — well-formed,
plausible numbers to exercise the defenses with. It is not a study of the
Ghanaian user population, and no prevalence or adoption figure is computed.

## Workload tiers

`study.js` runs five discrete, escalating tiers. Each tier is a bounded batch
with a query count fixed in advance; a recovery check (a small T0-scale batch)
gates advancement between tiers, and any sustained halt makes the current tier
the ceiling — the run stops there rather than escalating further.

| Tier | Label | Queries | Interval |
|------|-------|---------|----------|
| T0 | Baseline | 50 | 5 s |
| T1 | Conservative | 100 | 30 min |
| T2 | Moderate | 6,000 | 1 s |
| T3 | Aggressive | 60,000 | 1 s |
| T4 | Stress (optional, `--t4`) | 10,000 | 100 ms |

## What it records

Data minimization is structural, not post-hoc. The persistent state
(`study-state.json`) holds only:

- per-tier status (`complete` / `halted`) and an in-flight query-count checkpoint;
- an event log of halt/recovery signals (`disconnect`, `auth_failure`, `error`)
  with the tier, phase, and query index at which they occurred.

No phone number, no registration status, no profile data, and no list of
WhatsApp-associated numbers is ever written to disk.

---

## Setup & usage

**Prerequisites**
- Node.js 18+
- A WhatsApp account to authenticate with

**Install dependencies**
```bash
pnpm install
```

**Run the study**
```bash
node study.js          # T0 through T3
node study.js --t4     # also attempt the optional T4 stress tier
```

On first run a QR code is printed to the terminal — scan it with WhatsApp to
authenticate. The session is persisted locally, so subsequent runs reuse it.
Progress is checkpointed to `study-state.json`; re-running resumes at the right
tier (and mid-tier) instead of starting over.

**Report the results**
```bash
node report.js                       # reads ./study-state.json
node report.js --store other.json    # or a specific state file
```

`report.js` never touches WhatsApp, so it's safe to run while `study.js` is
still going. It prints, per attempted tier, the completion status, queries
issued before any halt, the halt/recovery signal if any, the overall
restriction frequency, and the full event log.

---

## Files

- `study.js` — the harness: drives the WhatsApp Web session and runs the tiers.
- `tiers.js` — tier definitions, the Ghana candidate-number generator, and the
  bounded per-tier batch runner.
- `store.js` — load/save the persistent study state.
- `report.js` — read-only descriptive report over the accumulated state.
