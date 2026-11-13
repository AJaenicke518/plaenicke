# Notifications for plaenicke: research and recommendation

Date: 2026-10-27. Research only: no feature code, no app files changed.

Labels: **concrete** means verified in this repo's code or in a cited primary source, and I can say exactly how it would be built. **speculative** means it needs a test (usually on the iPhone) before anyone relies on it.

## 0. Summary

**Recommendation (revised after sparring and a devil's-advocate review; section 6):** build notifications in two stages, and stop after stage 1 unless Alex says he needs per-item reminders.

- **Stage 1: one daily morning push, scheduled by the server, with no item data in it** ("Your day: open plaenicke"). The phone subscribes on a tap in Settings and uploads its subscription and a preferred hour. A Cron Trigger on the existing Worker sends it each morning with VAPID. It cannot go stale because it depends on no item data. It is the "prompt to open it" that the September UI research asked for (`docs/superpowers/research/2026-09-23-plaenicke-ui-research.md:35`, `:123`). Its daily arrival also tests whether Web Push stays reliable on Alex's own iPhone before anything harder is built. **concrete** design; on-device delivery **speculative** until tested.
- **Stage 2 (only on Alex's say-so): reminders for plaenicke's own items** (deadline nudges, "N min before" own timed events), recomputed by **any linked device after every local write and every applied sync**, not only on the phone's open. Feed events are left to Apple Calendar if Alex already has those calendars there. Whether reminder titles sit on the server encrypted or in plaintext is Alex's privacy call; section 6 states what the server already sees so the choice is made on facts.
- **Ruled out:** local scheduled notifications (no API on iOS; Notification Triggers abandoned), and a plaintext subscribed ICS feed or email as the primary channel.
- **Before any code:** Alex checks his iOS version (16.4+ needed, 18.4+ preferred), reads the "usage" line in Settings (the launch log, `js/settings.js:200`), and says which calendars are already in Apple Calendar.

The draft recommended stage 2's design straight away, with phone-only scheduling. The strongest objection, that a phone-computed schedule is frozen at the last open and goes wrong silently, is why it is now staged (section 5, finding 1).

## 1. What plaenicke has today (Phase 1)

### 1.1 Who uses it, on what

- **iPhone home-screen app: confirmed.** UI research records Alex's answer "**iPhone mostly.**" (`docs/superpowers/research/2026-09-23-plaenicke-ui-research.md:9`). The voice spike ran in the "home-screen app, iPhone" (`docs/superpowers/research/2026-10-20-home-screen/autonomous-brief.md:19`). V1 shipped with "Add to Home Screen on iPhone" as the device step (`~/punchlists/punchlist-plaenicke.md:5`). The manifest sets `"display": "standalone"` (`manifest.json:5`), which is what iOS needs before it offers Web Push.
- **iOS version: NOT confirmed.** Nothing in the repo, docs or punchlist records which iOS version the phone runs. This matters: Web Push needs iOS 16.4+, Declarative Web Push needs 18.4+ (section 2). Open question for Alex.
- A second linked device exists: a laptop (CLAUDE.md, "Sync has now run for real": "laptop + iPhone, against production D1").

### 1.2 Where a reminder could come from

Item shape (`js/items.js:28-45`): `date` (YYYY-MM-DD, required, `js/items.js:15`), `time` and `endTime` (HH:MM or null, `js/items.js:17-22`), `type`, `done`, plus title/notes. Types: `ITEM_TYPES = ['due', 'start', 'milestone', 'event', 'task', 'idea']` (`worker/src/prompt.js:16`), shown as Deadline, Start, Milestone, Event, To-do, Idea (`js/itemsheet.js:43-46`).

| Trigger source | Has a time? | Notes |
|---|---|---|
| Timed own event (`type` `'event'` **or `'general'`**, `time` set) | yes, wall-clock HH:MM | Natural "N minutes before". The client's event set is `EVENT_TYPES = new Set(['event', 'general'])` (`js/today.js:19`); `general` is every pre-V6 record's type. The Worker's `ITEM_TYPES` lacks `general`, so it is the wrong list to key client rules on (correction from the devil's-advocate pass). |
| Deadline (`due`), Start, Milestone, To-do (`task`) | optional (`time` may be null, `js/items.js:17`); I have no data on how often it is set | To-do types are `due/start/milestone/task` (`js/items.js:62`). A date-only deadline needs a chosen fire time (e.g. a morning digest). |
| Undone to-do | — | `isTodo` = to-do type and `done !== true` (`js/items.js:67`). A reminder for something already ticked must be cancelled. |
| Idea | no | `isScheduled` is false for ideas (`js/items.js:58`); never notify. |
| Feed (ICS) events, e.g. classes | yes | NOT in the synced items. Only feed URLs sync (`js/merge.js:316-323`, `toWire`); events are fetched per device through the Worker's `/feed` proxy (`js/feeds.js:218`) and expanded client-side (`js/ics.js:1281`, `expandEvents`). Only a client can compute them today. |

**No reminder field exists.** `makeItem` is a 13-key whitelist (`js/items.js:24-45`); CLAUDE.md warns that a field not added there is silently dropped at creation, and that the type list is copied four times. A per-item "remind me" setting is a data-model change with those costs. A rule-based first version (fixed rules per type) needs no data-model change.

**Times have no time zone.** `date`/`time` are local wall-clock strings; the device zone is read at runtime (`js/app.js:153`, re-read on resume at `js/app.js:1598`). Turning an item into an absolute instant has to happen on a device that knows the zone. A server cannot do it from the item alone.

### 1.3 Existing time-based logic

- **Nothing that fires when the app is closed.** A search of `js/`, `service-worker.js`, `worker/src`, `index.html` for remind/notif/alarm/Notification/push finds no notification or reminder code (only sync "push" in the push-to-server sense).
- **Foreground-only clock:** Today's view ticks every 60 s (`js/app.js:1189`, `TODAY_TICK_MS`) only while Today is shown and the page is visible (`js/app.js:1216-1226`, `syncTodayTick`), and renders "in N min" labels (`js/today.js:91-102`, `relativeLabel`). This is the only "time-relative" code, and it stops when the app is hidden.
- `VALARM` appears only in the ICS *parser*, which skips alarm components so their DURATION is not read as event data (`js/ics.js:446`, `js/ics.js:1021-1022`). There is no ICS *export* in the app.

### 1.4 The service worker

`service-worker.js` (cache `plaenicke-v6-16` in this worktree at `service-worker.js:13`; the caller reports v6-17 on main) only handles `install`, `activate` and a same-origin network-first `fetch` (`service-worker.js:27-63`). No `push` or `notificationclick` handler. **The app stores everything in `localStorage`** (`js/storage.js:13-18`, `:164`, `:260`), and service workers cannot read `localStorage` — so a service worker cannot compute reminders from local data without a new IndexedDB mirror. (Evidence: MDN's [Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API) exposes storage "via the `Window.sessionStorage` and `Window.localStorage` properties", and MDN's [list of APIs available to workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Functions_and_classes_available_to_workers) includes IndexedDB but not Web Storage. Neither page says "not available in workers" in those words; the conclusion follows from `localStorage` being a `Window` property. **concrete**.)

### 1.5 The Worker: what it stores and when it runs

- Runs **only on HTTP requests**: one `fetch` export, no `scheduled` handler (`worker/src/index.js:144-186`). `wrangler.toml` has no `[triggers]`, no Durable Objects, one D1 binding (`worker/wrangler.toml`).
- Routes: `/feed`, `/version`, `/` (smart-add), `/data`, `/admin/device` (`worker/src/index.js:151-173`).
- D1 holds two tables: `devices` (token hash, name, timestamps) and a single-row `data` table with an **opaque encrypted blob** (`worker/migrations/0001_init.sql`). "The server never decrypts or parses `blob`" (`worker/src/data.js:4-6`).
- **The encryption key never reaches the Worker** (`worker/src/auth.js:8-10`; spec `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md:50`: "The server cannot decrypt your data even with full database access"). Feed URLs inside the blob are capability tokens (`worker/src/data.js:4-7`).

**Consequence that shapes everything below:** the Worker cannot read a single item date, time or title. Any server-side scheduler needs the client to hand it fire times. Whether it may also hand it titles in plaintext is a privacy decision for Alex, because it changes what "the server cannot read your calendar" means.

### 1.6 Earlier notes on notifications

- V1 deferred "Real phone notifications / reminders that fire when the app is closed" (`docs/superpowers/specs/2026-07-17-plaenicke-design.md:49`).
- V4 spec: "iOS supports Web Push for home-screen PWAs (16.4+), but it needs a push service in the Worker + subscription storage (KV) — the first server-side state in the app" (`docs/superpowers/specs/2026-07-28-plaenicke-v4-design.md:317-319`). V5 has since added D1 state, so "first server-side state" no longer applies.
- UI research: "Web Push morning agenda and app badge … needs a scheduled job on the Worker" (`docs/superpowers/research/2026-09-23-plaenicke-ui-research.md:123`).

## 2. Platform facts (Phase 2)

### 2.1 Web Push on iOS home-screen web apps

- **iOS/iPadOS 16.4+, home-screen web apps only.** "A web app that has been added to the Home Screen can request permission to receive push notifications" — [WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). Needs a manifest with `display` `standalone` or `fullscreen` (same source). plaenicke has it (`manifest.json:5`). **concrete**
- **Permission needs a user gesture.** "When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code" — [Apple, Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers). **concrete**
- **Delivery runs over APNs.** "Web Push on iOS and iPadOS uses the same Apple Push Notification service that powers native push" — WebKit 13878. No Apple Developer account needed (same source). Endpoints are `*.push.apple.com` (Apple doc). **concrete**
- **App closed:** pushes are delivered by the OS to the Lock Screen / Notification Center / Watch (WebKit 13878). The app does not need to be open; that is the point of push. **concrete**
- **No silent pushes.** "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site" (Apple doc). **concrete**
- **Protocol limits (Apple doc):** payload ≤ 4 KB; `TTL` required (messages stored up to 30 days if undeliverable); `Urgency: high` to "attempt to deliver the notification immediately"; `Topic` (≤32 chars) coalesces; VAPID JWT `exp` ≤ 1 day ahead, `sub` must be URL or `mailto:`, "Don't refresh your JWT more frequently than once per hour"; 410 = "The device token has expired"; 429 = too many requests. **concrete**
- **Focus modes** apply to web-app notifications (WebKit 13878). **concrete**
- **Badging** (`setAppBadge`) is supported for home-screen apps (WebKit 13878). **concrete**

### 2.2 Declarative Web Push (iOS 18.4+)

- "Declarative Web Push is now available on iOS and iPadOS 18.4 for web apps added to the Home Screen" — [WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/). **concrete**
- The push message is JSON with a top-level `"web_push"` key and a `"notification"` dict; `title` and `navigate` (URL) are required. The browser shows it without running service-worker JavaScript; a service worker may optionally rewrite it. "There is no penalty for service workers failing to display a notification" — [WebKit, Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/). **concrete**
- Why this matters: with classic Web Push, a service-worker bug or a failed fetch inside the `push` handler can cost the subscription (section 2.1). Declarative messages remove that failure mode. Payloads are still RFC 8291-encrypted in transit.

### 2.3 Reliability reports (not primary specs, but recurring)

- [WebKit bug 273063](https://bugs.webkit.org/show_bug.cgi?id=273063), "webPush subscription becomes invalid for few users", status NEW, iOS 17.4.1. A WebKit engineer said the bugs "weren't in WebKit but rather in Web.app" and fixes were in iOS 17.5 RC; a later commenter needed to resubscribe after iOS 17.6. The reporter notes `pushsubscriptionchange` does not fire on iOS. **concrete** that the reports exist; **speculative** whether current iOS still has it.
- [Apple Developer Forums 728796](https://developer.apple.com/forums/thread/728796): developers report pushes stopping after a few messages on iOS 16.4+. [Apple Developer Forums 848080](https://developer.apple.com/forums/thread/848080): push service returns success, no push event on iPad. User reports; **speculative** for plaenicke.
- Design consequence (**concrete**): the client must re-check `pushManager.getSubscription()` on every open and re-upload if it changed or vanished, and the app should show when notifications last worked. A 201 from the push service is not proof of delivery.

### 2.4 Scheduling without a server

- **Notification Triggers API (`showTrigger`) is dead.** "The development of Notification Triggers API, part of Google's capabilities project, has ended" — [Chrome for Developers, Notification Triggers](https://developer.chrome.com/docs/web-platform/notification-triggers). It was never in Safari. **concrete**
- iOS gives a home-screen web app no background execution timer. `setTimeout` in the page stops when hidden (plaenicke itself already relies on this, `js/app.js:1216-1226`). There is no web API to schedule a local notification for later. **concrete** (absence: no such API in MDN's Notifications or Push API pages; Triggers was the only proposal).
- So, on iOS, **a notification that fires while the app is closed requires a server push** or a native app (Calendar/Reminders) holding the alarm.

### 2.5 Server side on Cloudflare

- **Cron Triggers:** minimum one-minute granularity, UTC, "may take several minutes (up to 15 minutes) to propagate" after a config change, and run "on underutilized machines"; no exact-second promise — [Cloudflare, Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Free plan: 5 cron triggers per account, 10 ms CPU per cron invocation, 50 subrequests per invocation, 100,000 requests/day — [Cloudflare, Workers limits](https://developers.cloudflare.com/workers/platform/limits/). **concrete**
- **Durable Object alarms:** one alarm per object at a time; `setAlarm` overrides; "guaranteed at-least-once execution"; retried with exponential backoff from 2 s, up to 6 retries; precision not stated — [Cloudflare, DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). DOs are on the Free plan with SQLite storage only (100k requests/day, 5 GB) — [Cloudflare, DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). **concrete**
- **Sending push from a Worker:** Node's `web-push` package depends on Node crypto. Web-Crypto ports exist and name Workers as a target: `@block65/webcrypto-web-push`, `web-push-browser`, `@pushforge/builder`, `web-push-neo` (found by search; not audited). **speculative** which one is maintained and correct; the protocol itself (RFC 8291 aes128gcm + RFC 8292 VAPID ES256) is implementable with Web Crypto.
- **CPU budget:** whether a VAPID ES256 sign plus an RFC 8291 encryption fits the Free plan's 10 ms is **speculative** until measured. Two things shrink it: the JWT can be cached up to an hour or more (Apple allows ≤ 24 h expiry, and asks for no more than one refresh per hour), and the encryption can be done by the client (next point).
- **The client can do the RFC 8291 encryption.** The inputs are the subscription's ECDH public key and auth secret, which the user agent hands to the page ("The ECDH public key and the authentication secret are sent to the application server", [RFC 8291 §2](https://www.rfc-editor.org/rfc/rfc8291)), plus an ephemeral key pair the *sender* generates and discards. Nothing stops the page itself acting as the encrypting party. So the phone can encrypt "Physics lab in 15 min" for its own subscription and give the Worker only ciphertext and a fire time. **concrete** as protocol; **speculative** as a tested implementation.

### 2.6 Alternatives that do not need Web Push

- **ICS file with `VALARM`, imported into Apple Calendar.** The app could generate a one-off `.ics` for an item; Calendar holds the alarm natively. No server, nothing leaves the device. But each import is a manual copy: an edit or delete in plaenicke does not follow. Whether opening a generated `.ics` from a *standalone* home-screen app hands it to Calendar cleanly is **speculative** (needs the phone).
- **plaenicke as a subscribed ICS feed with `VALARM`.** Native, reliable alarms if iOS honours them. But (a) the Worker would have to serve plaintext items, which ends the "server cannot read your calendar" property (`docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md:50`); (b) iOS has a per-subscription "Remove Alarms" switch, and user reports disagree on how alarms from subscribed calendars behave ([Chron guide](https://smallbusiness.chron.com/disabling-alarms-calendar-iphone-78756.html), [Apple Developer Forums 711389](https://developer.apple.com/forums/thread/711389?page=3)). I found no Apple primary source on whether iOS honours `VALARM` in a subscribed feed. **speculative**. The V4 spec already listed "plaenicke as a feed" as heavy for the same plaintext reason (`docs/superpowers/specs/2026-07-28-plaenicke-v4-design.md:323-327`).
- **Email.** Needs plaintext on the server, adds a mail dependency, and the V5 spec notes "No email service exists" (`docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md:22`). iOS Mail push timing depends on the account. Weakest fit.
- **Badge only.** `setAppBadge` while the app is open (WebKit 13878) can show "3 due today" on the icon, but only updates when the app runs or a push arrives. A complement, not a reminder.

## 3. Candidate approaches (DRAFT)

### A. Server-scheduled Web Push, client-encrypted payloads, Cron + D1 (draft recommendation)

1. Settings gets "Turn on reminders" (a tap = the user gesture). It subscribes with `userVisibleOnly: true` and the Worker's VAPID public key. **concrete**
2. On every open/sync, the phone computes reminders for the next N days from items **and** feed instances (app.js already expands feed instances with `instancesForRange` for Today, `js/app.js:1143-1147`; `js/today.js` is pure and receives them, `js/today.js:1-4`), using rules (e.g. 15 min before a timed event; 8:00 morning digest of today's deadlines and undone to-dos). It encrypts each payload with RFC 8291 for its own subscription and `PUT`s the whole set to a new device-token-authenticated route, replacing the previous set. **concrete** design; **speculative** client crypto library.
3. New D1 table `reminders(device_hash, fire_at, ciphertext, endpoint, …)`. A `* * * * *` Cron Trigger selects due rows, POSTs each to the endpoint with a cached VAPID JWT, `TTL` short (a 15-minute reminder is useless an hour late), `Urgency: high`, then deletes the row; on 404/410 it drops the subscription and the client sees "reminders are off" next open. **concrete** design.
4. Service worker gains `push` and `notificationclick` handlers; payload uses the Declarative Web Push shape so iOS 18.4+ shows it even if the SW fails. **concrete** design; on-device behaviour **speculative** until tested.

What the server learns: when reminders fire, how many, and the push endpoint — not titles. Cost: new route, new D1 table, a `scheduled` handler, a VAPID key secret, SW changes, client crypto.

### B. Same as A, but Durable Object alarm instead of Cron

One SQLite DO holds the rows and sets its alarm to the earliest `fire_at`; `alarm()` sends due rows and re-arms. Runs only when something is due, and a single object serialises its own work, so two senders cannot race. (The draft said it "fires at the scheduled instant"; Cloudflare does not state alarm precision, so that claim is withdrawn.) At-least-once with up to 6 retries (Cloudflare DO alarms). Cost: first DO in the codebase (class, migration, binding). **concrete** design.

### C. Calendar export (no push)

"Add to Calendar" on the item sheet generates a single-item `.ics` with a `VALARM`. Zero server change, zero privacy change, OS-grade reliability. Edits/deletes do not follow; feed events are already in Apple Calendar if Alex subscribes there directly. **concrete** to build; **speculative** whether the hand-off from a standalone PWA works.

### Ruled out

- Local scheduled notifications (no API on iOS; Triggers abandoned).
- Subscribed plaintext ICS feed / email (end the server-cannot-read property; alarm behaviour on iOS unverified).

## 4. Stress test: constructive sparring

Run with the `jaeger:constructive-sparring` skill on approach A, by me (the same agent that wrote the draft). Its three required outputs:

**The load-bearing assumption.** That the phone opens plaenicke often enough, and soon enough after every change, for its uploaded schedule to be right. In approach A only the phone can produce its own ciphertext, so a deadline added on the laptop, a to-do ticked on the laptop, a feed event moved by its publisher, or a time-zone change has no effect until the phone is next opened in the foreground. Sync only runs while visible (CLAUDE.md, "Only the visible tab syncs"; `js/app.js:1674-1686`). If the phone is not opened for a day, its schedule silently runs out at the horizon. Every failure here is silent: a missing notification looks the same as nothing being due.

**The tradeoff.** Client-side RFC 8291 encryption gains at-rest privacy for titles: D1 would hold only fire times and ciphertext, which matches the V5 rule that the server stores nothing readable (`worker/src/data.js:4-6`). It loses three things: the Worker cannot regenerate or fix a schedule, another device cannot schedule for the phone without fetching the phone's subscription keys, and the app takes on a second hand-rolled crypto path (ECDH + HKDF + AES-GCM in a specific record format) that can only be proven against Apple's real push service. Note what the Worker already sees *in transit*: every feed's full ICS body passes through `/feed` (`worker/src/feed.js`, `js/feeds.js:218`) and every smart-add sentence passes through `/` (`worker/src/index.js:37-65`). So the encryption buys at-rest privacy, not transit privacy.

**The unsurfaced problem.** Nothing in the repo says what Alex wants to be reminded *of*. Feed events (classes, shared calendars) come from calendars Apple Calendar can subscribe to directly and alert for natively; the items only plaenicke knows about are its own deadlines and to-dos (`js/items.js:62`), most of which are date-only. If the real need is "don't miss a deadline", a once-a-day morning digest plus a day-before deadline nudge covers it with a handful of pushes, and per-event "15 minutes before" reminders (the part most hurt by a stale schedule and by APNs/cron latency) may not be needed at all. Building the general scheduler first risks building the hard part for the case that matters least.

Resolution of each is in section 6.

## 5. Stress test: devil's advocate

A `jaeger:devil-advocate-reviewer` agent was dispatched on the draft (sections 0-3) with the repo to check against. It returned 13 findings (1 critical, 7 major, 5 minor). I re-checked the cited lines it relied on that I had not read myself (`ui-research.md:35`, `:44`, `:80`, `:82`; `js/today.js:19`; `js/storage.js:322-360`; `worker/src/feed.js:6-12`, `:237-266`) and they say what it said. It could not open `js/sync.js` (its search tool was denied), so it did not check where a post-sync hook would attach.

| # | Severity | Challenge | Resolution |
|---|---|---|---|
| 1 | critical | The phone-only schedule is a snapshot frozen at the phone's last open: laptop adds/edits/ticks are missed, travel shifts own (floating-time) items but not feed (absolute) events, the horizon silently runs out, and the push meant to prompt opening only stays right if the app is opened. A confidently wrong push repeats the stale-data trust failure in `ui-research.md:44`. | **Accepted; it reshaped the recommendation.** Stage 1 carries no item data, so nothing can go stale. Stage 2 recomputes on every write and every applied sync on any device, and the server stores the phone's `p256dh`/`auth` so the laptop can encrypt for it (RFC 8291 decryption needs the phone's private key, which never leaves it). Replace-all uploads carry a generation check. |
| 2 | major | "Keeps the V5 promise" overstates it. V5 encrypts because feed URLs are capability tokens (V5 spec line 24). The Worker already sees smart-add text in plaintext (`worker/src/index.js:37-53`) and full feed bodies, cached 15 min (`worker/src/feed.js:237-266`). | **Accepted.** Section 6 restates the choice as encrypted-at-rest vs plaintext-at-rest (rows that sit for days vs a 15-minute cache), plus Worker CPU, and hands it to Alex. |
| 3 | major | Detection does not catch the cited failure: in WebKit 273063 / Forums 848080 the subscription looks valid and the push service reports success. "Show when notifications last worked" had no mechanism; the SW cannot write `localStorage`. | **Accepted.** Stage 1's daily push is the canary: one push at a fixed time, so its absence is noticeable. The SW `push` handler POSTs an ack to the Worker; the app shows "last morning push: sent / acknowledged" from the server. Whether the SW's push handler runs for a declarative message on iOS is **speculative** (WebKit says SW JS "can optionally change the contents", which implies it runs, but untested here). |
| 4 | major | Cron select → POST → delete can double-send and overlap; late rows flush in a burst (TTL does not stop the Worker sending late); "cached JWT" has no store; revoked devices keep receiving. | **Accepted.** Claim rows atomically (`UPDATE … RETURNING` or delete-returning; SQLite has `RETURNING` since 3.35, whether D1 exposes it is **speculative**, check first); drop rows more than a set number of minutes late; persist JWT + expiry in D1; join `devices` on send so a revoked token stops pushes. |
| 5 | major | A simpler option was missing: a content-free daily prompt, scheduled by the server alone. | **Accepted as stage 1.** |
| 6 | major | The problem was not shown to be real at this scope; feed calendars may already alert natively in Apple Calendar; the launch log (`js/storage.js:348-387`) was not consulted. | **Accepted.** Feeds drop out of stage 2 if Alex already has those calendars in Apple Calendar. The launch log lives in the phone's `localStorage`, so I cannot read it; Settings displays it (`js/settings.js:200`). Moved to open questions. |
| 7 | major | Rules keyed on `'event'` skip every `general` record; the client's set is `EVENT_TYPES` (`js/today.js:19`). | **Accepted.** Section 1.2 corrected; stage 2 imports that set, not a copy (CLAUDE.md warns the type list is already copied four times). |
| 8 | major | Client-side crypto is a bigger unknown: no bundler, so any library must be a vendored ES module added to `ASSETS` with a `CACHE` bump; none of the listed packages was checked for browser use; hand-rolled crypto is the category CLAUDE.md says only execution catches. | **Accepted.** Stage 1 needs no client crypto. Stage 2 must start with a spike (encrypt on the iPhone, send through APNs, see one notification arrive) before any design is fixed. |
| 9 | minor | B's "fires at the scheduled instant" contradicts "precision not stated". | **Accepted;** claim withdrawn (section 3 B). Cron vs DO is argued on concurrency safety vs new infrastructure instead. |
| 10 | minor | Imprecise citations (`syncTodayTick` lines; "today.js expands feeds"; "usually date only"). | **Fixed** in sections 1.2, 1.3, 2.4, 3. |
| 11 | minor | One short TTL is wrong for a digest: an offline phone at 8:00 loses the day's only prompt. | **Accepted:** TTL per kind (hours for the morning push, minutes for "N min before"). |
| 12 | minor | Reminders from feed instances must respect device-local `plaenicke.seriesVisibility` (`js/storage.js:324-333`); the on/off flag and subscription must be device-local in `storage.js`. | **Accepted** for stage 2; stage 1 reads no feed data. |
| 13 | minor | A laptop subscription would duplicate every reminder. | **Accepted:** stage 2 sends per-item reminders to one chosen device unless Alex wants both; stage 1 is opt-in per device. |

**Not challenged** by the reviewer, after checking: the server cannot compute fire times (opaque blob, key never on the server, zone-less times); no local scheduling exists on iOS; service workers cannot read `localStorage`; approach A leaves `merge()`, `toWire()`, `schemaVersion` and `makeItem` alone.

## 6. Revised recommendation

### Stage 1: daily morning push (recommended now)

1. **Settings → "Morning reminder" toggle + hour.** The tap is the user gesture; it calls `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. The subscription state and on/off flag are device-local keys in `js/storage.js` and never enter the synced blob. **concrete**
2. **New authenticated route** (device token, like `/data`) stores `{endpoint, p256dh, auth, hour, timeZone}` in a new D1 table keyed by `token_hash`, reusing the existing auth (`worker/src/auth.js:45-55`). **concrete**
3. **Cron Trigger** (e.g. every 15 minutes; the Free plan allows 5 per account) finds subscriptions whose local morning hour has arrived and that have not been sent today, claims them atomically, and POSTs a fixed message with `Urgency: high`, a TTL of a few hours, and a VAPID JWT stored in D1 with its expiry. It joins `devices`, so revoking a device stops its push, and marks a subscription dead on 404/410. Converting the stored IANA zone to a local hour inside the Worker needs `Intl` time-zone support in workerd: **speculative**, check first; the fallback is the client uploading the next 14 fire instants on each open. Otherwise **concrete**.
4. **Payload in the Declarative Web Push shape** (`web_push`, `notification.title`, `navigate` to the app URL) so iOS 18.4+ shows it even if the service worker fails, plus a SW `push` handler (for older iOS, and to POST an ack) and a `notificationclick` handler. **concrete** design, **speculative** on device.
5. **Visible health:** the app shows "last morning push sent … / acknowledged …" from the server, re-checks `getSubscription()` on every open, and offers one-tap re-subscribe if it is gone. **concrete**
6. **Worker crypto for one constant message:** at most one RFC 8291 encryption and one ES256 signature per send, with the JWT reused for hours. Whether that fits the Free plan's 10 ms CPU is **speculative**; measure on first deploy. A variant with no Worker-side encryption: the phone encrypts the constant message once at subscribe time and the Worker resends the same ciphertext. RFC 8291 does not forbid resending a record, but I have not verified iOS accepts it: **speculative**.

Cron rather than a Durable Object: stage 1 sends a few messages a day, the codebase has no DO yet, and an atomic claim in D1 removes the race a DO would otherwise solve. If stage 2 brings minute-level reminders, one DO whose alarm is set to the earliest row is the better fit (serialised by construction, runs only when due).

**What stage 1 adds to what the server knows:** the push endpoint, the preferred hour, the device's time zone. No item data.

### Stage 2: own-item reminders (only if Alex wants them)

- **Scope:** own items only. Timed events use `EVENT_TYPES` imported from `js/today.js:19`; deadline nudges use `due`/`start`/`milestone`/`task` that are not `done`. Feed events only if Alex does not already get them from Apple Calendar, and then filtered through `plaenicke.seriesVisibility`.
- **Rules first, no per-item field:** avoids the `makeItem` 13-key whitelist change (`js/items.js:24-45`) and the four-copy type list.
- **Freshness:** recompute and replace the uploaded set after every local write and every applied sync, on whichever device made the change; replace-all upload with a generation check; drop late rows; TTL per kind; one target device.
- **Privacy choice for Alex, on the real baseline:** the Worker already sees smart-add sentences and full feed contents in transit and keeps feed bodies in its edge cache for 15 minutes (`worker/src/feed.js:15`, `:258-266`), but stores nothing readable at rest. Reminder rows would sit in D1 for days. (a) **Plaintext titles at rest:** simplest; any device or the Worker can rebuild the set. (b) **Client-encrypted titles (RFC 8291 by the sending device):** keeps "nothing readable at rest" but needs a vendored crypto module, proven on the device by a spike first. Fire times reveal the shape of the schedule either way.
- **Option C** (per-item "Add to Apple Calendar" `.ics` with `VALARM`) stays a cheap, server-free complement for an item that must not be missed; edits do not follow.

### Ruled out

- Local scheduled notifications on iOS (no API; Notification Triggers ended).
- A plaintext subscribed ICS feed, or email, as the main channel: both put readable calendar data at rest on a server, and I found no primary source on how iOS handles alarms in subscribed calendars (section 2.6).

## 7. Open questions only Alex can answer

1. **Which iOS version is the iPhone on?** Below 16.4 there is no Web Push; 18.4+ gets Declarative Web Push.
2. **What do you want to be reminded of?** A morning "open your day" prompt, a day-before nudge on deadlines, "15 minutes before" an event, or a mix? Nothing in the repo records this.
3. **Are your class/shared calendars already in Apple Calendar on the phone, and do they alert you?** If yes, plaenicke should not duplicate them.
4. **What does the usage line in Settings (the launch log) say on the phone?** It shows how often the app opens, which bounds how stale any phone-computed schedule would be.
5. **For stage 2: may reminder titles sit on the Worker in plaintext**, given it already sees feeds and smart-add text in transit? Or must they stay encrypted at rest?
6. **Is the Cloudflare account on Workers Free or Paid, and does it already use Cron Triggers elsewhere?** Free allows 5 per account and 10 ms CPU per cron run.
7. **Phone only, or the laptop too?** A laptop subscription doubles every reminder unless one device is chosen.

## Sources

- WebKit, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- WebKit, Meet Declarative Web Push: https://webkit.org/blog/16535/meet-declarative-web-push/
- WebKit, Features in Safari 18.4: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- Apple, Sending web push notifications in web apps and browsers: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- Chrome for Developers, Notification Triggers (ended): https://developer.chrome.com/docs/web-platform/notification-triggers
- MDN, PushManager.subscribe(): https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- MDN, Web Storage API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API
- MDN, APIs available to workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Functions_and_classes_available_to_workers
- RFC 8291, Message Encryption for Web Push: https://www.rfc-editor.org/rfc/rfc8291
- WebKit, Updates to storage policy: https://webkit.org/blog/14403/updates-to-storage-policy/
- WebKit bug 273063: https://bugs.webkit.org/show_bug.cgi?id=273063
- Apple Developer Forums: https://developer.apple.com/forums/thread/728796 , https://developer.apple.com/forums/thread/848080 , https://developer.apple.com/forums/thread/711389?page=3
- Cloudflare, Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare, Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare, Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Cloudflare, Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Chron, disabling alarms on subscribed calendars (secondary): https://smallbusiness.chron.com/disabling-alarms-calendar-iphone-78756.html
- Web-Crypto push libraries found by search, not audited: https://www.npmjs.com/package/@block65/webcrypto-web-push , https://cdn.jsdelivr.net/npm/web-push-browser@1.4.2/README.md , https://npmjs.com/package/@pushforge/builder , https://github.com/ryoppippi/web-push-neo

## Retro

- **Friction:** Apple's developer docs render client-side, so the page URL returned only a title. The JSON form (`developer.apple.com/tutorials/data/documentation/<path>.json`) returned the full text; use it first next time.
- **What the stress test changed:** the draft solved the hardest version (per-event, phone-computed, client-encrypted) before asking what Alex needs. The devil's advocate's finding 1 and the sparring's "reminded of what?" point were the same gap from two sides. Next time, put "what does the user actually need" into Phase 1, before candidate designs.
- **Unverified, worth a spike before any plan:** declarative push plus SW ack on Alex's iOS version; `Intl` time zones in workerd; D1 `RETURNING`; Worker CPU for one send.
