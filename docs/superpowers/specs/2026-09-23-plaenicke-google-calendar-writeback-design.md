# plaenicke — editing Google Calendar events (Project B)

**Date:** 2026-09-23
**Status:** **DRAFT. Written during an autonomous run and not reviewed.** No devil's-advocate pass or plan exists yet. It needs Alex's decisions (§ 8) before a plan is written.
**Research:** `docs/superpowers/research/2026-09-23-google-calendar-writeback-research.md`. Every UNVERIFIED claim there is still unverified here.
**Depends on:** Project A (`feature/edit-items`). This reuses its item sheet, `applyEdit` validation and undo toast.

## 1. Goal

Alex's words: edits to linked events should "change it in Google too". Tapping a Google event in plaenicke opens the same sheet as his own items. Saving changes the real event in Google Calendar, and plaenicke shows the change immediately.

**Out of scope:**
- iCloud: it has no clean write API.
- Canvas: assignment dates are set by instructors.
- Outlook.
- Creating new Google events from plaenicke.
- Editing "this and following" recurring instances.
- Invitations and attendees.

## 2. Why the iCal link isn't enough

- The iCal secret address is read-only.
- Google reportedly updates it hours late. **UNVERIFIED — measure this first (§ 7 step 0).** If the lag is real, an edit written through the API would look reverted until the feed caught up.
- **So Google calendars move off the ICS feed and onto the Calendar API for both reading and writing.** An edit then shows up the next time the data is read, not hours later.

## 3. Decisions (recommended; the § 8 items need Alex)

| Decision | Recommendation | Why |
|---|---|---|
| OAuth flow | **Authorization-code flow run by the Worker**, publishing status **In production (unverified)** | In Testing mode, access has to be granted again **every 7 days** (documented). In production and unverified, it's granted **once**, with a one-time "unverified app" warning. The browser-only token model needs a popup roughly every hour, and popups have reported failures in iOS home-screen apps. |
| Scope | `calendar.events` | The smallest scope that covers every calendar Alex can see. `calendar` itself would also allow sharing and deleting calendars. |
| Where the refresh token lives | A Worker secret store: a D1 table, encrypted at rest with a key held as a Worker secret | Google says to store it "in a secure, long-lived location". The Worker already holds the admin secret. |
| How an ICS event maps to an API event | `events.list?iCalUID=<UID>` | Google documents that `iCalUID` differs from `id`, so building the id by editing the string is unsafe. |
| Recurring events | Edit **this occurrence only**, through its instance id | Google warns against editing instances one by one when the goal is to change the whole series. "Whole series" editing can come later. |
| Reading | `events.list` with `syncToken` for incremental changes; poll when the app opens | Push notifications need channels renewed by hand. Polling is enough for one user. |

## 4. The security cost, stated plainly

Today the server holds only ciphertext it can't read, plus an admin secret. This project adds **a long-lived credential that can change Alex's whole Google Calendar**, stored on the server. It also means **Google event contents pass through the Worker in plaintext**. The ICS proxy already does that, so the new part is the stored credential and the ability to write.

**Mitigations:**
- Request the smallest scope.
- Encrypt the token at rest.
- The Worker only ever makes Calendar API calls on behalf of an authenticated device token.
- A "Disconnect Google" control that revokes the token at Google (`https://oauth2.googleapis.com/revoke`) and deletes it from storage.

## 5. Components (sketch; the plan will make these exact)

**Worker:**
- `GET /google/connect` → a redirect to Google consent (`access_type=offline`, `prompt=consent`, a `state` bound to the device).
- `GET /google/callback` → exchanges the code, stores the refresh token and redirects back to the app.
- `GET /google/events?calendarId&syncToken` → proxies `events.list`.
- `PATCH /google/events/:calendarId/:eventId` → proxies `events.patch`.
- `POST /google/disconnect` → revokes the token and deletes it.
- Every route requires a device token (the Plan 4 auth flip becomes a prerequisite for these routes only).

**Client:**
- A Google calendar is a new feed kind, `{ kind: 'google', calendarId }`, alongside ICS feeds. It gets its own cache of API events with `id`, `recurringEventId`, `originalStartTime` and `etag`.
  - **This touches the synced feed record, so it needs `schemaVersion` analysis before it's built.**
  - The alternative is keeping Google connections device-local.
- The item sheet gets an editable mode for Google events: title, date, time and end time. Saving goes through `PATCH` with `If-Match: etag`. A 412 means someone changed the event in Google, so the sheet shows the new values and asks again.
- Undo uses the same toast, and re-PATCHes the previous values.

## 6. Failure modes to design for

- The refresh token is revoked or expires after 6 months unused. The sync indicator shows "Reconnect Google", and editing falls back to read-only with a message saying so. It is never a silent failure.
- An etag conflict (412), as above.
- The event was deleted in Google, so the API returns 404 or 410. The item is removed from the cache, with a message.
- The 100-refresh-tokens-per-client cap: reconnecting repeatedly retires old tokens silently. Keep one token and replace it on reconnect.
- The `iCalUID` lookup returns 0 or 2+ results. The item is read-only, with the reason shown.

## 7. Rollout

0. **Measure first, for free:** edit a Google event, then time how long until the iCal secret address shows the change. Use a manual Sync in plaenicke, since it bypasses the edge cache. If the lag is minutes rather than hours, a cheaper design is possible: write through the API, keep reading the ICS feed, and show a local "pending" override until the feed catches up. That would make the migration of reads in § 2 unnecessary.
1. **Alex creates** a Google Cloud project, OAuth consent screen (External, In production), and a Web application OAuth client with the Worker's callback URL. He then puts the client secret in as a Worker secret. **These steps need his Google account.**
2. The Worker routes and token storage, with tests using a fake Google.
3. Test the redirect flow **on the iPhone home-screen app** before any client UI is built. Whether iOS standalone apps handle this redirect is UNVERIFIED.
4. Reading through the API.
5. Editing.

## 8. Decisions that are Alex's

1. **Accept the security cost in § 4?** It's the first server-held credential that can change his data.
2. **Should Google connections sync between his devices, or stay on each device?** Syncing is more convenient. Device-local avoids a `schemaVersion` change and keeps the credential off the second device.
3. **Recurring events: this occurrence only, for now?**
4. **Run step 0 first?** It might remove the need to migrate reads at all.
