# Google Calendar read/write — research for Project B

**Date:** 2026-09-23. Collected by a research agent from primary Google sources. **UNVERIFIED** marks anything no primary source confirmed.

## OAuth setup (personal app)

- **Scopes.** `calendar.events` = "View and edit events on all your calendars", the smallest scope covering every calendar. `calendar.events.owned` covers only calendars you own. `calendar` also allows sharing and deleting calendars (too broad). Source: https://developers.google.com/workspace/calendar/api/auth
- **Sensitive, not restricted.** Reading Calendar events is Google's own example of a *sensitive* scope (https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification). No primary source lists a Calendar scope as *restricted*. How each individual scope is classified is UNVERIFIED; the Cloud console shows it.
- **The 7-day rule is confirmed.** In "Testing" status with an External user type, the refresh token expires in 7 days, unless the only scopes requested are name/email/profile. Sources: https://developers.google.com/identity/protocols/oauth2 and https://support.google.com/cloud/answer/15549945
- **"In production" while unverified is allowed for personal use.** Verification has an exception "if you are the only user of your app". Two costs:
  - an unverified-app warning screen;
  - a lifetime cap of 100 users that can't be reset.

  Sources: sensitive-scope-verification page; https://support.google.com/cloud/answer/7454865
- **In production, refresh tokens still die** on any of:
  - revocation;
  - 6 months without use;
  - the 100-tokens-per-account-per-client cap;
  - a time-limited grant expiring;
  - session policies.
- **"Internal" isn't available to a personal @gmail.com account.** It needs a Google Cloud Organization, which needs Workspace or Cloud Identity.

## Where the flow and tokens live

| Option | Details | Sign-in frequency |
|---|---|---|
| (a) GIS token model, in the browser only | No refresh token. Access token lasts `expires_in` (about 1h in Google's sample). Renewing needs a user button press and a popup. Google rates it the *least* secure. Popups in an iOS home-screen app have reported failures (UNVERIFIED) | A popup for most sessions |
| (b) Code flow run by the Worker | Google's recommended option. Needs the client secret (keep it as a Worker secret). Refresh token returned only on the first exchange with `access_type=offline`. GIS supports `ux_mode: 'redirect'`, which avoids the popup | Testing: re-consent **every 7 days**. In production and unverified: **once** |

**Recommended:** (b), In production and unverified, with scope `calendar.events`. The redirect behaviour in an iOS home-screen app is UNVERIFIED and must be tested on the phone first.

**Security cost:** the Worker would hold a long-lived credential that can edit the whole calendar, and it would see Google events in plaintext. The ICS proxy already passes Google data through in plaintext today, so what's new is the stored credential plus write access.

## Mapping ICS events to the API

- **Don't assume `UID = <eventId>@google.com`.** Google's docs say `iCalUID` and `id` differ. Look events up with `events.list?iCalUID=<UID>` instead (https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
- **Recurring events:**
  - Each instance has `recurringEventId` and `originalStartTime`.
  - To edit one instance, PUT to the instance id. To edit the whole series, update the parent event.
  - "This and following" has no API operation; it would mean splitting the series (UNVERIFIED).
  - Source: https://developers.google.com/workspace/calendar/api/guides/recurringevents
- **Incremental sync:** `syncToken` / `nextSyncToken` return only changes, including deletions. An expired token returns 410, which means doing a full sync again (https://developers.google.com/workspace/calendar/api/guides/sync).

## Push, quotas, cost

- **Push notifications** need an HTTPS receiver; a `workers.dev` domain should qualify (UNVERIFIED end-to-end). Channels need manual renewal. **Not worth it for one user:** polling when the app opens is enough.
- **Quotas:** 10,000 requests per minute per project, 600 per minute per user, and a threshold of 1M per day per project. Standard use is free (https://developers.google.com/workspace/calendar/api/guides/quota).

## Open questions (UNVERIFIED — test before relying on them)

- Whether Google's iCal export really lags edits by hours.
- How the OAuth redirect behaves inside the iOS home-screen app.
- The instance-id string format.
