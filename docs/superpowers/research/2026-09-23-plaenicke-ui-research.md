# plaenicke — why it's hard to use, and what would fix it

**Date:** 2026-09-23
**Status:** Research, not a spec. Nothing here is approved or built.
**Inputs:**
- Three research agents: app survey, principles plus iOS PWA feasibility, and a code-level friction audit.
- Constructive sparring on the draft direction.
- A devil's advocate on the draft direction.
- Alex's answers: the failures are **checking my day**, **fixing/moving**, and **look and feel**. Capture is **not** a failure. **iPhone mostly.**

Labels: **concrete** means verified in code or sourced. **speculative** means it needs testing.

---

## 1. Why successful apps are easy to use

The apps people stick with aren't the ones with the most features. Each one has **a single home screen that answers one question the moment it opens**. Everything else is one tap away.

| App | The question its home screen answers |
|---|---|
| Things 3 | "What am I doing today?" It opens on Today, with calendar events at the top ([Cultured Code](https://culturedcode.com/things/support/articles/2803583/)) |
| Fantastical | "What's coming up?" DayTicker: a strip of days above one mixed list ([MacStories](https://www.macstories.net/reviews/the-new-fantastical-review/)) |
| Structured | "What does my day look like in time?" A single-day timeline ([help](https://help.structured.app/en/articles/380546)) |
| Todoist | Home defaults to Today ([help](https://www.todoist.com/help/articles/change-your-home-view-OKOgnH4r)) |

**The principles behind it, and the evidence:**

1. **The default screen is the product.** Most people never change defaults ([NN/g](https://www.nngroup.com/articles/the-power-of-defaults/)). *Strong.*
2. **Direct manipulation, always with a non-gesture fallback.** Every app pairs long-press and drag with a quick "move to…" action. NN/g says to provide the menu alternative on mobile, because gestures can't be discovered by looking ([drag-drop](https://www.nngroup.com/articles/drag-drop/), [swipe](https://www.nngroup.com/articles/contextual-swipe/)). *Strong.*
3. **Undo, not "are you sure?".** People stop reading confirmation dialogs and click through them out of habit ([Raskin](https://alistapart.com/article/neveruseawarning/), [NN/g](https://www.nngroup.com/articles/confirmation-dialog/)). Google Calendar and Todoist show an undo snackbar. *Strong.*
4. **A toggle takes effect immediately, where the thing lives.** Google's coloured box, Notion's eye icon and TickTick's Show/Hide all apply without a Save step ([NN/g toggles](https://www.nngroup.com/articles/toggle-switch-guidelines/)). *Moderate to strong.*
5. **Edit in place.** Things expands a card inside the list. Google added drag so that changing a time wouldn't mean opening the editor ([9to5Google](https://9to5google.com/2017/07/19/google-calendar-android-quick-time-edit-gesture/)). *Moderate.*
6. **Thumb reach.** 49% of phone use is one-handed ([Hoober](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)). Apple's minimum target is 44pt. Separate sections go in a tab bar; closely related views go in a segmented control ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/tab-bars)). *Strong.*
7. **Feedback within 0.1 seconds** feels instant ([NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/)). *Strong.*
8. **Something has to prompt you to open it.** Behaviour needs motivation, ability *and* a prompt ([Fogg](https://www.behaviormodel.org/prompts/)). Productivity tools "fall apart" when users are busy and the plan changes ([Kamsin et al., CHI 2012](https://dl.acm.org/doi/10.1145/2212776.2212457)). Rescheduling therefore has to be cheap. *Moderate.*

---

## 2. Why plaenicke fails at each of Alex's three problems (concrete, file:line)

**Checking my day:**
- It opens on the List view (`index.html:62`). That list starts at the **oldest** item you ever made, not today (`app.js:100-105`, `329`). Dates are raw ISO strings, and nothing marks today.
- There's no Today button. The date, the week and the month are each set once, at load (`app.js:75-77`).
- **The data goes stale.** iOS resumes a home-screen app instead of reloading it, but plaenicke only recomputes "today" and only fetches calendar feeds at load (`app.js:76`, `538`). The resume handler only runs account sync (`app.js:643-645`). Open it at 11pm, come back at 8am, and it shows yesterday with yesterday's calendar data. **This may be part of why you stopped trusting it.**
- The six view buttons are equal peers, and there's no home screen. All the controls sit at the top of the screen, out of thumb reach.

**Fixing/moving:**
- Nothing can be edited except the to-do checkbox. A typo or a wrong date means delete and re-type.
- Re-typing a to-do by hand brings it back as `general`, which isn't a to-do type, so it disappears from the To-do page (`app.js:187`, `items.js:62-67`).
- A ticked to-do can't be unticked: it disappears and no screen shows it again.
- Delete is one tap with no undo. The deletion syncs to your other device about 2 seconds later.

**Look and feel:**
- Tap targets are 20–30px against the 44pt guideline. The Day view's delete × is tiny.
- Three sets of inputs are under 16px, which makes iOS zoom in when you tap into them: the preview's fields, Add-calendar, and the link code.
- Settings has no close button and may not scroll on a phone.
- styles.css uses 11 font sizes, about 11 spacing values, 5 corner radii and 13 competing colours.
- There's no animation, and one grey message line for both success and errors.
- Week view shows 8px coloured bars with no text.

**Calendars:** hiding one takes gear → scroll → Hide → tap outside the panel. You can't tell which calendar an event came from.

---

## 3. Recommended plan

### Phase 0: a one-day check (do this first)

This comes from the devil's advocate's strongest objection. A full redesign rests on the assumption that layout is why you don't open the app. Other explanations would survive any redesign:
- you don't trust it to be current (see the stale data above);
- nothing prompts you to open it;
- your real calendar lives somewhere else.

So first, about 20–40 lines of code:
1. **Refresh when the app comes back to the screen.** On `visibilitychange → visible`: recompute today, jump the Day view forward if it was showing the old today, and re-fetch stale calendar feeds (`backgroundSyncFeeds`, which already respects the 30-minute threshold). Show an "Updated 8:02" stamp. Test by moving a fake clock across midnight. *Concrete.*
2. **Open on today**: the Day view for today, until a Today screen exists. *Concrete.*
3. **Human dates and a today marker** in List ("Wed, Sep 23"). *Concrete.*
4. **A local-only launch log** (a timestamp for each open, shown in Settings). This gives a baseline, so "do I open it every morning now?" can be answered with numbers rather than memory. *Concrete.*

Then use it for a week. If you still don't open it, a new layout won't change that, and the problem is the prompt or trust. That would move morning Web Push up the list.

**Optional, costs nothing:** for the same week, subscribe Apple Calendar directly to the Canvas feed and try Fantastical's free tier. If that fixes "checking my day", plaenicke's job shifts toward capture and fixing things.

### Phase 1: a Today home screen (checking my day; no sync risk)

Constructive sparring's point of view, which I recommend: **"The Day Sheet".** plaenicke's home screen answers "what's my day?" and adds one student-specific section.
- A week strip at the top. Tap a day to switch to it.
- A large date ("Wednesday, September 23") and a **Next** card ("PHYS 201 at 10:30 · in 42 min").
- One merged list: **Overdue** (unticked to-dos from before today, shown only on today), then all-day items and deadlines, then timed items with a now-line. To-dos get checkboxes.
- A **Due this week** section showing the next 3–5 deadlines. This is what makes the Canvas feed useful rather than noise.
- **Keep the smart-add box on this screen.** Capture is the part that works, so don't hide it behind a + button. (The draft did hide it; the devil's advocate caught that.)
- A **bottom tab bar**: Today | Calendar (Day/Week/Month switcher) | To-do | Ideas. Tapping the Today tab while already on Today jumps back to today.
- **One-tap calendar chips** in the Calendar view. Each shows its state (filled or outline) and applies immediately.
- **Tap any item** to open a read-only sheet showing title, time and which calendar it came from.

**Traps (concrete, from the devil's advocate):**
- **Build Today from ONE `visibleItems(day, day)` call.** It already includes to-dos. Adding `todoItems()` on top shows every to-do twice. Checkbox state comes from `record.done`.
- **Calendar chips must not write from app.js's snapshot of `feeds`.** If a sync added a calendar since that snapshot was taken, saving the stale list makes the next sync treat the missing calendar as deleted. That writes a tombstone and **permanently loses a feed URL**. Fix: move settings.js's `reapplyFeedField` into feeds.js as `setFeedHidden(id, hidden)`, which re-reads storage before writing. Test with a sync landing between the snapshot and the tap.
- **The detail sheet can't show location or notes for calendar events.** The ICS parser keeps only the title. Adding more is its own piece of work, with a storage check.
- **The bottom bar needs `env(safe-area-inset-bottom)`** (the body only pads the top today). Prototype the bar and sheets **on the iPhone itself** before committing to the layout. There are community reports of viewport-height bugs in home-screen mode (*speculative*).
- **Every new module** has to be added to `service-worker.js` ASSETS, and CACHE bumped.
- **Add a type selector to manual add**, so a hand-typed to-do can be a to-do.

### Phase 2: fixing and moving (touches sync; spec first)

- **Tap an item → sheet with Edit, Tomorrow, +1 week, Pick date, and Delete.** Non-drag paths first. Drag-to-reschedule comes later as an extra (Pointer Events work on iOS, but they need long-press or a handle to avoid fighting scrolling).
- **Every edit goes through `makeItem({...record, ...patch})`**, plus `normalizeIdea`. An in-place patch skips validation and can store `date: ''` from a cleared date box, which CLAUDE.md already names as a trap.
- **Sync policy for edits:** decide it in writing and update `merge.js`'s header. My recommendation is to accept whole-record last-write-wins: one user, two devices, rarely editing the same item at once. The cost, stated honestly: if you edit an item on one device and tick it on the other before they sync, one of the two changes is silently lost. Per-field timestamps would avoid that, but they change what `merge()` means and should bump `schemaVersion`.
- **Undo toast** for delete, tick and move. **Delay the delete itself:** hide the item, show "Deleted · Undo" for 5 seconds, and write the tombstone only when the toast expires. If the app closes during those 5 seconds, the item survives. That's the safe direction to fail in.
- **A Completed section** on the To-do page, so a tick can be undone. It needs its own filter, since `isTodo` hides done items.

### Phase 3: look and feel (constructive sparring's concrete list)

- **Keep:** the cream, paper and leather palette, the serif headings, and dark mode. They're distinctive.
- **Four font sizes:** 13, 16, 20 and 28px. **A second typeface for controls:** system UI with tabular numerals for times and buttons, and Georgia for titles.
- **A spacing scale** of 4/8/12/16/24. **Two corner radii:** 8 and 14.
- **Denser lists:** grouped rows with hairline dividers instead of floating cards, so a whole day fits on one screen.
- **Colour means source or category.** Type is shown by shape (◆ deadline, bar for an event, checkbox for a to-do). The brown accent is reserved for "today/now".
- **Shadows only on floating layers.** 200–250ms sheet slide-ups and toast fades, switched off under `prefers-reduced-motion`.
- **44pt targets and 16px inputs everywhere, and a close button on Settings.**

### Later
- Web Push morning agenda and app badge. This is the prompt. It works on iOS 16.4+ in home-screen apps only, after you grant permission, and it needs a scheduled job on the Worker.
- Drag-to-reschedule. Search. Recurring items of your own. Saved calendar sets. Only rendering the view that's on screen (today, every change re-renders all six, including a 366-day calendar expansion for the hidden List view).
- Calling `navigator.storage.persist()`: a cheap guard for the link codes.

---

## 4. Where the reviewers disagreed, and my call

| Question | Constructive | Devil's advocate | Call |
|---|---|---|---|
| Start with the redesign, or a probe? | Week-one redesign | A ten-line check first | **Check first.** It's cheap, and it tests whether layout is really why you don't open the app (§3 Phase 0) |
| Add box behind a + button? | Yes | No: it's the part that works | **Keep it inline** |
| How to do "move" | Copy to a new id, then delete the old one: avoids the sync decision | Edit in place via `makeItem` and accept last-write-wins | **Edit in place.** Copy-then-delete still resurrects the item if the other device ticks it before syncing, and then you have **two** copies (merge.js:22-30). Changing the id also breaks undo and anything else that refers to it. *Speculative: neither was executed. Settle it with a two-device test.* |
| How to undo a delete | Delay the delete | Restore with a new timestamp: traced as sound, provided it restores the same id into the live `items` | **Delay the delete.** Fewer conditions to get right |
| Publish plaenicke as an ICS feed for Apple Calendar | Rejected: it would mean the server sees plaintext (breaks the end-to-end design), subscribed calendars are read-only, and Google refreshes them every 12–24h | — | **Rejected** for now |

## 5. iOS home-screen feasibility (concrete, sourced)

| Works | Doesn't work |
|---|---|
| Pointer drag; HTML5 drag-and-drop (iOS 15+); View Transitions (Safari 18+); Web Push (16.4+, home-screen apps only); badging (needs notification permission); safe-area insets; haptics **only** via `<input type="checkbox" switch>` on iOS 18 | Vibration API; manifest shortcuts; Share Target |

Sources: [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [WebKit badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/), [WebKit Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/), [firt.dev iOS PWA notes](https://firt.dev/notes/pwa-ios/), [caniuse pointer](https://caniuse.com/pointer).

## 6. What is not verified

- Whether the Today screen actually changes whether Alex uses the app. That's why Phase 0 exists.
- The viewport and bottom-bar bugs in home-screen mode (community reports only).
- The copy-then-delete versus edit-in-place trade-off: reasoned from `merge.js`, not executed.
- Claims about other apps rest on the research agents' cited sources. I did not re-fetch them.
