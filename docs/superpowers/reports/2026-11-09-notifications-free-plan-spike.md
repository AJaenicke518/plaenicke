# Notifications on the Workers Free plan: feasibility spike

Date: 2026-11-09. Throwaway spike. No app code changed, nothing deployed, no push sent to any real endpoint. Builds on `docs/superpowers/reports/2026-10-27-notifications-research.md` (branch `worktree-agent-adff218c12f90165b`).

Labels: **concrete (measured)** = I ran it and give the numbers. **concrete (cited)** = a primary source says so, quoted. **speculative** = inference or untested; says what would settle it.

## 0. Answer

- **Free fits.** The heaviest realistic cron run (a cold isolate plus 3 sends in the same minute) measured about **2.2 ms of crypto CPU** in local workerd, against a **10 ms** limit. A warm send costs **0.07 to 0.09 ms**. **concrete (measured)** on an Apple M4 Pro. Cloudflare's production CPUs are not that machine, so the headroom on the real edge is **speculative**. It is about 4.5x on these numbers. Check it on the first deploy (section 6).
- **WebCrypto counts as CPU time.** Cloudflare's docs say nothing about this either way. workerd's source says the crypto runs synchronously on the request thread, and in my measurement the workerd process's CPU matched the in-Worker timings within 2 %. Budget it as CPU. **concrete** (source + measured).
- **Declarative Web Push changes only the JSON inside the message.** Encryption (RFC 8291 aes128gcm), VAPID and the HTTP request are the same as classic Web Push. **concrete (cited)**.
- **Scheduling: one minutely Cron Trigger on D1.** Each run claims due rows with `UPDATE … RETURNING`, drops rows more than 15 minutes late, and sends. This uses 1 of the account's 5 Cron Triggers and 1,440 of 100,000 daily requests. No Durable Object is needed. **concrete** design, verified against local D1.
- **No Free-plan blocker found.** Nothing here forces the $5 Paid plan. Section 5 lists what is still unverified.

## 1. Free plan limits (verified 2026-11-09)

All from Cloudflare docs fetched today. Every row is **concrete (cited)**.

| Limit | Free value | Source |
|---|---|---|
| CPU per HTTP request | 10 ms | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), "CPU time" table |
| CPU per Cron Trigger | 10 ms | same table ("CPU time per Cron Trigger") |
| Cron Triggers per account | 5 | same page, account plan limits |
| Subrequests per invocation | 50 (internal services: 1,000) | same page, "Subrequests" |
| Requests per day | 100,000 (Error 1027 past it) | same page |
| Cron wall time | 15 min per invocation | same page, "Wall time" |
| D1 queries per Worker invocation | 50 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 storage | 500 MB per DB, 5 GB total, 10 DBs | D1 limits |
| D1 rows read / written | 5 million/day, 100,000/day; past either, "you will not be able to run queries against D1" | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Durable Objects on Free | "available both on Workers Free and Workers Paid plans", "Only Durable Objects with SQLite storage backend"; 100,000 requests/day, 13,000 GB-s/day, 5 GB | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |

Cron invocations count as requests. Cloudflare's own pricing example bills an hourly cron as "720 requests/month" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), Example 3). **concrete (cited)**

Cron granularity and timing: the docs give no minimum interval, but `* * * * *` is documented as "At every minute". Triggers run in UTC, and a config change "may take several minutes (up to 15 minutes) to propagate". **No firing-time guarantee is stated** ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). **concrete (cited)**

## 2. Q1: Can a Free Worker send Web Push within 10 ms of CPU?

### 2.1 Does WebCrypto count toward CPU time?

- The Cloudflare docs define CPU time as "how long the CPU spends executing your Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time." Crypto is not mentioned either way ([limits § CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). The Web Crypto page says only that WebCrypto "is significantly faster than performing them purely in JavaScript" ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). **I found no Cloudflare statement that WebCrypto is excluded.** **concrete (cited, absence)**
- workerd source, `src/workerd/api/crypto/crypto.c++` (main, fetched 2026-11-09): *"NOTE(perf): The SubtleCrypto interface is asynchronous, but all of our implementations perform the crypto synchronously before returning. … it's unclear that we would want a single request to be able to use multiple cores -- certainly it would greatly complicate our implementation of request CPU limits."* `sign`, `encrypt` and `deriveBits` are all wrapped in `js.evalNow(...)`. The work happens on the isolate's thread inside the call, so it is CPU time for the request. **concrete (cited source)**
- Measured cross-check (section 2.3): for 20,000 iterations × 3 operations, the in-Worker timer summed to **1,693 ms** and the workerd process's own CPU (`ps cputime`, all threads) rose by **1,720 ms**. At 5,000 iterations: 410 ms vs 410 ms. No thread pool hides any of the work. **concrete (measured)**

Conclusion: **budget every WebCrypto call as CPU time.**

### 2.2 Implementation and correctness

`scripts/spike-webpush-lib.mjs` contains about 90 lines of WebCrypto only: a VAPID ES256 JWT (RFC 8292) and RFC 8291 aes128gcm encryption (ECDH P-256 → HKDF-SHA-256 IKM → CEK/nonce → AES-128-GCM, one record, 0x02 delimiter, 86-octet header). No dependency. The same file runs in Node and in workerd.

`node scripts/spike-webpush-vector.mjs` checks it three ways:
- It reproduces RFC 8291 Appendix A byte for byte (ecdh_secret, IKM, CEK, NONCE, full body).
- An independent `node:crypto` receiver decrypts a message encrypted with random keys.
- A VAPID JWT verifies under `node:crypto` (`ieee-p1363`).

All checks passed. **concrete (measured)**

- Two mutations each turned the check red: delimiter `0x02`→`0x01`, and `"WebPush: info"`→`"WebPush: inf0"`. **concrete (measured)**
- Side finding: the RFC's Section 5 example says `Content-Length: 145`, but the body it prints decodes to 144 octets (86-octet header plus the 58-octet ciphertext in Appendix A). The script matches the printed bytes.

The scratch Worker (`scripts/spike-webpush-worker/`, local only) ran full sends against a local fake push service (`fake-push.mjs`). The fake verified the JWT signature and `k=`, required `Content-Encoding: aes128gcm`, decrypted the body, and checked the declarative shape (`web_push: 8030`, `title`, `navigate`). **71 of 71 sends were accepted (201)**, including 3 from the real `scheduled()` handler (fired through `--test-scheduled`). **concrete (measured)**. Apple's real endpoint was **not** contacted (section 5).

### 2.3 CPU numbers

Setup: Apple M4 Pro, Darwin 25.3.0, Node v22.18.0 (OpenSSL 3.0.16), wrangler 4.159.0 (workerd darwin-arm64), `compatibility_date = 2026-07-18`. Cloudflare says local `performance.now()` advances during CPU work: "if you need to measure timing of a piece of code that is CPU intensive … run your Worker locally, via Wrangler" ([Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)). In local workerd the timer has **1 ms resolution**, so per-operation figures come from loops of 2,000 to 20,000 operations.

**A. workerd, in-Worker timer (authoritative for this spike).** Loop means:

| Operation | n=2,000 | n=5,000 | n=20,000 |
|---|---|---|---|
| import VAPID private key (JWK, ECDSA) | 0.0155 ms | 0.0116 ms | 0.0114 ms |
| VAPID JWT sign (ES256) | 0.0145 ms | 0.0138 ms | 0.0139 ms |
| RFC 8291 encrypt (179 B declarative payload → 283 B body) | 0.057 ms | 0.0566 ms | 0.0595 ms |

**B. workerd, one whole send minus the network.** This covers parsing a D1-shaped row, building the payload JSON, encrypting, building headers and constructing the `Request`. Runs of n=20,000, two each:
- JWT cached: **0.069 ms and 0.075 ms per send**
- JWT signed on every send: **0.083 ms and 0.092 ms per send**

**C. workerd, cold isolate.** The source file was edited to force a reload each time, five samples. The first send's crypto (import key + sign + encrypt + Request) measured **1, 2, 0, 1, 1 ms** at 1 ms resolution, plus one earlier sample of 0 ms. Script parse and startup sit under Cloudflare's separate startup limit and are not included.

**D. workerd, process CPU cross-check.** See 2.1: the process CPU delta matched (A) within 2 %.

**E. Node WebCrypto, used only as a proxy** (`scripts/spike-webpush-bench.mjs`, `process.cpuUsage()`, n=2,000):
- import key: 0.080 ms
- sign: 0.037 ms
- encrypt: 0.290 ms
- full send: 0.393 ms
- cold first encrypt: 1.243 ms

Node is about 4 to 5x slower than workerd here. Its WebCrypto hops through a thread pool, and workerd's (BoringSSL, synchronous) does not. Do not use Node figures to judge the Workers budget, except as a pessimistic bound.

All of section 2.3 is **concrete (measured)** on this machine. **speculative:** production CPU on Cloudflare hardware. No published per-operation numbers exist. Even if production ran 4x slower, the heaviest run below stays under 10 ms.

## 3. Q2: Declarative Web Push (iOS 18.4+)

- Encryption and sending: unchanged. WebKit: "Sending a push message to that push subscription works exactly as before. For a notification to be handled declaratively the contents of the push message must match the declarative standard JSON format" ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)). The W3C Push API processing steps decrypt "using … the process described in [RFC8291]" first. Only then do they run "the declarative push message parser" on the resulting bytes. A message that cannot be decrypted is acknowledged and dropped ([Push API editor's draft](https://w3c.github.io/push-api/)). So the payload must still be aes128gcm-encrypted with VAPID. **concrete (cited)**
- Shape: top-level `"web_push": 8030`, and `"notification"` with a non-empty `"title"` and a required `"navigate"` URL. `body`, `lang`, `dir`, `silent` and `app_badge` are optional (same WebKit post). The spike's payload, `declarativePayload()` in the lib, is 179 bytes for a typical reminder. The RFC 8291 cap is 3,993 bytes of plaintext (RFC 8291 § 4). A morning summary listing about 10 titles fits. **concrete (cited + measured)**
- Behaviour: if a service worker is installed, "a push event is dispatched to it like before". If it fails to show a replacement, "the fallback is used", and "browsers don't have to apply their 'silent push penalties'" (same WebKit post). That removes the subscription-revocation risk the research report flagged. **concrete (cited)**. On-device behaviour on Alex's iPhone is **speculative** until tested.
- Available "on iOS 18.4, iPadOS 18.4" (same WebKit post). Alex's iOS version is still unrecorded (research report § 0). **concrete (cited)**

Declarative push costs the server nothing extra. It is the same encryption, with different JSON inside.

## 4. Q3: Scheduling on Free

### 4.1 Options

| | Minutely Cron + D1 claim | Per-reminder DO alarms (one DO, alarm = earliest row) |
|---|---|---|
| Available on Free | Yes: uses 1 of 5 account Cron Triggers | Yes: SQLite-backed DOs only (cited, § 1) |
| Timing | Minute granularity, no stated firing guarantee | "guaranteed at-least-once execution", retried from 2 s backoff up to 6 times; precision not stated ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)) |
| CPU limit per run | 10 ms (cited) | **Ambiguous on Free.** The DO limits table says "CPU per request: 30 seconds (default)", and the same page's FAQ says DOs "have the same per invocation CPU limits as any Workers do". **speculative** |
| New infrastructure | `[triggers]` + `scheduled()` + 2 tables in the existing D1 | DO class, migration, binding, a second store beside D1 |
| Daily quota use | 1,440 requests (1.4 % of 100k) | about 10 alarms + about N client writes |
| Concurrency | `UPDATE … RETURNING` claim: a second run cannot re-claim | Serialised by construction |

**Recommendation: minutely Cron + D1.** Crypto costs the same either way. Cron adds no new runtime concepts. For "30 minutes before", the difference between minute granularity and alarm precision does not matter. The only benefit a DO would bring, serialisation, the atomic claim already provides. **concrete** design.

### 4.2 The claim, as tested (local D1)

```sql
UPDATE reminder SET claimed_at = ?now
 WHERE claimed_at IS NULL AND fire_at <= ?now AND fire_at > ?now - 900000
RETURNING id, title, body, <subscription columns>;
```

With a partial index `ON reminder(fire_at) WHERE claimed_at IS NULL`, measured against the local (miniflare) D1:
- 10 due rows were sent.
- A row 1 hour late and a row 1 hour early were **not** claimed.
- An immediate second run claimed **0** (no double send).

**concrete (measured, local D1).** Whether production D1 accepts `RETURNING` is **speculative**. D1 is SQLite and local D1 accepted it, but I found no Cloudflare doc stating it. Check with one `wrangler d1 execute --remote` against a scratch table before building on it.

`Intl` time zones work in workerd: `America/Chicago` and `Europe/Berlin` conversions came out correct. That means the server could compute "7:00 local". It is simpler to have the client upload UTC fire instants. **concrete (measured, local)**

### 4.3 Per-run budget for a realistic day

Day: 1 morning summary, about 6 event reminders, about 3 deadline nudges, so about 10 sends spread over 1,440 minutely runs.

| Run type | Count/day | Crypto CPU (from § 2.3) | D1 queries | Push fetches |
|---|---|---|---|---|
| Nothing due | about 1,430 | 0 (no crypto); one claim query. A local `/tick` with 0 rows measured 0 ms at 1 ms resolution | 1 | 0 |
| 1 send, warm isolate | most of the 10 | 0.07 to 0.09 ms | 1 to 3 (claim, JWT cache read/write) | 1 |
| Heaviest realistic: cold isolate + 3 sends in one minute (07:00 summary + 2 nudges) | rare | at most 2 ms cold + 2 × 0.09 ≈ **2.2 ms** (22 % of 10 ms) | 3 | 3 |
| Stress: 48 sends in one run (local `/tick`) | never in real use | about 48 × 0.09 ≈ 4.3 ms + cold | 3 | 48 (just under the 50 limit) |

Quotas per day:
- Requests: about 1,440 cron runs plus the app's existing traffic, out of 100,000.
- D1 rows written: about 10 claims, about 2 JWT refreshes (12 h expiry, refreshed when under 1 h is left; Apple asks for no more than one refresh per hour, per the research report § 2.1), plus whatever the client uploads.
- D1 rows read: the partial index keeps idle runs near 0 rows.

Client uploads are **speculative** until the upload design exists. Rewriting about 50 rows on each of about 20 writes a day is about 1,000 rows of the 100,000-a-day allowance.

Sends per invocation stop at **50 subrequests on Free**. If a claim ever returns more, cap the claim with `LIMIT 40` (D1 supports `LIMIT` on UPDATE, per its changelog in search results; **speculative** until checked) and leave the rest for the next minute.

## 5. Q4: Free-plan blockers

**None found.** Nothing measured or cited forces Paid. What is still unverified, and what each depends on:

1. **Production CPU for the crypto.** It measured 2.2 ms worst-case on an M4 Pro. Cloudflare publishes no per-operation figures. **speculative.** Settle it on the first deploy (section 6).
2. **Apple's endpoint.** No real subscription existed, so nothing went to `web.push.apple.com`. The JWT format, `aud` = endpoint origin, and the headers follow the RFCs and Apple's doc as summarised in the research report. Apple's acceptance is **speculative**.
3. **`RETURNING` on production D1.** **speculative** (§ 4.2).
4. **Other Cron Triggers on the account.** The limit of 5 is per account, not per Worker. Whether Alex's account already uses some is unknown.
5. **Cron firing jitter.** Cloudflare states no guarantee. A 30-minute reminder that arrives a minute or two late is fine. How late real runs are is **speculative** until logged.

None of these is a plan question. Paid would only matter if the per-run CPU turned out about 5x higher on production hardware than measured here.

## 6. How to measure production CPU without exposing feed URLs

`worker/wrangler.toml` sets `[observability.logs] invocation_logs = false`, because invocation logs record `/feed`'s capability URL. Cloudflare reports CPU time per invocation in exactly those logs ([limits § CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time): "CPU time and wall time appear in the invocation log"). So the existing Worker cannot show cron CPU without re-exposing feed URLs.

- **concrete:** put the `scheduled()` handler in a **second Worker** bound to the same D1 database (Free allows 100 Workers), and enable invocation logs there only. It serves no HTTP routes that carry secrets.
- **speculative:** the dashboard's aggregate CPU metrics might be enough without invocation logs. Not checked.

## 7. Files

- `scripts/spike-webpush-lib.mjs`: VAPID + RFC 8291 using WebCrypto only.
- `scripts/spike-webpush-vector.mjs`: RFC vector, independent decrypt, JWT verify. Run with `node`.
- `scripts/spike-webpush-bench.mjs`: Node CPU proxy.
- `scripts/spike-webpush-worker/`: the local-only scratch Worker. Routes: `/bench`, `/sendbench`, `/cold`, `/seed`, `/tick`, `/intl`, plus `scheduled()`. Also includes the fake push service, the process-CPU cross-check, the cold-isolate sampler and the keygen. `wrangler.toml` there has a placeholder D1 id and a do-not-deploy header. `.dev.vars` is gitignored.

None of these match a `node --test` pattern. `npm test` after adding them: `# tests 1921`, `# pass 1921`, `# fail 0`, `# cancelled 0`, and no spike file appears in its output.
