# What makes apps feel smooth and calm, and what transfers to an iOS PWA

**Scope.** Sourced: Apple (WWDC18/23), Linear, Superhuman, Flighty, Things 3, Structured, design engineer Emil Kowalski. **No usable primary writing found** for Todoist's redesign, Craft, Amie, Arc, Notion Calendar, Sunsama, TickTick, so they are omitted.

## Techniques

| Technique | App(s) | Source | Transfers to PWA? |
|---|---|---|---|
| Highlight on **touch-down** and confirm on lift. Dragging off the target cancels. Add an extra margin around the hit area so small finger movement doesn't cancel the tap | Apple iOS | [WWDC18 803](https://developer.apple.com/videos/play/wwdc2018/803/) | yes (needs the iOS `:active` fix, see below) |
| Avoid double-tap gestures, because supporting them delays every single tap | Apple | WWDC18 803 | yes |
| Motion must be **interruptible and redirectable**. A spring keeps its current velocity when it is retargeted | Apple | WWDC18 803; [WWDC23 10158](https://developer.apple.com/videos/play/wwdc2023/10158/) | partly (CSS transitions retarget from the current value but drop the velocity) |
| Springs are defined by duration and bounce. **Bounce 0 is the default.** About 0.15 feels brisk, 0.3 is noticeably bouncy, and anything above about 0.4 is too much. Add bounce only when the gesture itself had momentum (Music: tap to open uses 100% damping, swipe to dismiss uses 80%) | Apple | WWDC23 10158; WWDC18 803 | partly (CSS `linear()` can approximate a fixed spring curve) |
| **Spatial consistency**: a view leaves along the same path it arrived by. Things grow from where they started toward their final state | Apple | WWDC18 803 | yes (View Transitions, transforms) |
| 1:1 finger tracking at the touch point, ~10 pt before a drag starts, flick velocity projected to pick the landing spot | Apple | WWDC18 803 | partly (Pointer Events can do this by hand) |
| Rubber-band at edges so "end" never looks "frozen" | Apple | WWDC18 803 | yes (native in Safari) |
| Animations shorter than 300 ms, **ease-out**, and **never animate frequent or keyboard-triggered actions**. Animate only `transform` and `opacity`. Respect reduced motion | Kowalski | [emilkowal.ski](https://emilkowal.ski/ui/great-animations) | yes |
| Responses under 100 ms, targeting under 50 ms. A **local database** renders instantly and works offline. Preload and prerender the next likely view. "Minimal animations" | Superhuman | [Superhuman blog](https://blog.superhuman.com/superhuman-is-built-for-speed/) | yes |
| Local-first sync engine: the screen updates from local state first, then a transaction is queued to the server | Linear | secondary only ([performance.dev](https://performance.dev/what-makes-linear-feel-instant)) | yes (IndexedDB plus a write queue) |
| Colour themes generated in **LCH** from three inputs (base, accent, contrast) instead of 98 variables. Chrome colour is limited so the interface stays neutral. Elevation comes from black or white opacity. Labels and icons are strictly aligned | Linear | [Linear redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) | yes (`oklch()`/`lch()` in CSS) |
| Navigation is dimmed so the content leads. Fewer and softer dividers ("structure should be felt not seen"). Fewer, smaller icons, with decorative icon backgrounds removed. Warmer, less saturated grays | Linear | [Linear, Mar 2026](https://linear.app/now/behind-the-latest-design-refresh) | yes |
| Inter Display for headings, Inter for everything else | Linear | Linear redesign | yes |
| "Boringly obvious" reliability. Assume the connection will drop. Information is "always being there". Show the single value that matters so the user doesn't do arithmetic ("32 min… now 29 min"). One line per item, like airport boards | Flighty | [Apple, Behind the Design](https://developer.apple.com/news/?id=970ncww4) | yes |
| State-based presentation: the view switches format at defined moments (before takeoff, a progress counter appears) | Flighty | same | yes |
| Opening a task pops it out as a card while the list fades behind it. Long-press lifts an item so it can be dragged. Mostly white space, bold type, "thoughtful splashes of color" | Things 3 | [MacStories](https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/) | yes (View Transitions) |
| Today is split into a **"This Evening"** section. **Past events turn grey** in Today | Things 3 | MacStories | yes |
| Magic Plus: a single always-present add button that can be **dragged to a spot** to set context | Things 3 | MacStories | partly |
| Haptics on drag, on the Magic Plus button, and on pull-to-search | Things 3 | MacStories | partly (see haptics below) |
| A single vertical timeline mixing tasks and events, planning one day at a time. An Inbox holds unscheduled items until you drop them into a free slot. Animation on completion | Structured | secondary ([gori.me](https://gori.me/?p=167320)) | yes |

## The iOS home-screen PWA layer

- **View Transitions, same-document**: supported since Safari 18. You call `document.startViewTransition()`, and the default effect is a cross-fade. **sourced** ([WebKit, Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)). Cross-document transitions arrived in Safari 18.2. **sourced** ([Chrome docs compat table](https://developer.chrome.com/docs/web-platform/view-transitions/cross-document)). Whether Safari's back-swipe suppresses them is **speculative** (a single [W3C list report](https://lists.w3.org/Archives/Public/public-css-archive/2025May/0286.html)).
- **Momentum scrolling**: since iOS 13 it is the default for overflow elements, and `-webkit-overflow-scrolling: touch` is obsolete. **sourced** ([WebKit bug 198858](https://bugs.webkit.org/show_bug.cgi?id=198858)). Scroll-snap version not re-verified.
- **`overscroll-behavior`**: supported from Safari 16. Stops scroll chaining out of sheets. **sourced** ([caniuse](https://caniuse.com/css-overscroll-behavior)).
- **Tap delay**: `width=device-width` gives fast taps at the initial zoom level. `touch-action: manipulation` on an ancestor gives fast taps at every zoom level. **sourced** ([WebKit, More responsive tapping](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)).
- **`:active` on iOS**: it only fires when a touch listener is attached. Add an empty `touchstart` listener to the interactive elements or a container, and avoid putting it on body for performance reasons. If you set `-webkit-tap-highlight-color: transparent`, you must supply your own press state. **sourced** ([WebFundamentals #25](https://github.com/google/WebFundamentals/issues/25)). Known bugs: `:active` can stick when a touch turns into a scroll ([WebKit 255277](https://bugs.webkit.org/show_bug.cgi?id=255277), [221366](https://bugs.webkit.org/show_bug.cgi?id=221366)). A `pressed` class from pointer events is more controllable. **speculative**.
- **Vibration API**: not supported in Safari. **sourced** (search summary of caniuse, see [azukiazusa](https://azukiazusa.dev/en/blog/ios-safari-web-haptics)). **Workaround**: iOS 18 added haptics to `<input type=checkbox switch>` **sourced** ([WebKit Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)), and the [ios-haptics](https://npmjs.com/package/ios-haptics) library triggers it by clicking a hidden switch's label from script. [WebKit 285120](https://bugs.webkit.org/show_bug.cgi?id=285120) was filed to require a user gesture first and is marked fixed. A claim that iOS 26.5 broke the trick is **speculative** (unverified). Fragile; call only inside user gestures; test on device.
- **`prefers-reduced-motion`**: supported in Safari (I did not re-check the version), and recommended by both Apple and Kowalski. **sourced** (emilkowal.ski, WWDC guidance).
- **120 Hz**: Safari defaults to "Prefer Page Rendering Updates near 60fps". With that flag on (the default), rAF runs at 60 fps on ProMotion iPhones, and 120 fps only after the user turns the flag off in Settings. **sourced** ([WebKit 280183](https://bugs.webkit.org/show_bug.cgi?id=280183), WebKit engineer comment). Whether home-screen web apps on iOS 26 differ is **unresolved** ([WebKit 294338](https://www2.webkit.org/show_bug.cgi?id=294338)). Design for 60 fps.
- **Spring curves**: CSS `linear()` easing is supported since Safari 17.2. **sourced** ([Safari 17.2 notes](https://developer.apple.com/tutorials/data/documentation/safari-release-notes/safari-17_2-release-notes.md)). It can encode a pre-computed spring, but not velocity carried over from an interrupted animation. **concrete**
- **Safe areas**: `env(safe-area-inset-*)` with `viewport-fit=cover`. Not re-sourced in this pass. **speculative** as to details, standard practice.
- **Other "webby" tells**: grey tap highlight, tap delay, scroll chaining behind sheets (`overscroll-behavior: contain`), spinners on local actions. Fixes above.

## Eight highest-leverage recommendations for plaenicke (ranked)

1. **Never wait on the network for user actions.** Write to IndexedDB, render, then sync from a queue. Budget under 100 ms and target under 50 ms (Superhuman, Linear). No spinners for local writes. **concrete**
2. **Press state on touch-down for every tappable element.** A class toggled via `pointerdown`/`pointerup`/`pointercancel` (for example `scale(.97)` plus an opacity change, which are my values, **speculative**), `touch-action: manipulation`, a transparent tap highlight, and hit areas of at least 44 pt (Apple HIG figure, not re-fetched) with extra slop (WWDC18). **concrete**
3. **One motion vocabulary.** Under 300 ms, ease-out or a `linear()` spring with bounce 0, and only `transform` and `opacity`. Same path in and out. Under `prefers-reduced-motion`, swap movement for a cross-fade. **concrete**
4. **Don't animate high-frequency actions** such as checking off items, tab switches, or repeated adds. Use at most a short tick on the checkbox itself. Animation goes on rare, explanatory transitions like opening an item into a card (Kowalski, Superhuman). **concrete**
5. **"What's next" as one line per item, with relative time computed for the user**: "in 42 min", not "3:15" to subtract from the clock. Past items turn grey, and Today is split into day and evening (Flighty, Things 3). **concrete**
6. **Visual calm through restraint.** Neutral palette generated in `oklch()` from base, accent and contrast. One accent colour used only where it carries meaning. Fewer and softer dividers. Dimmed navigation. Fewer, smaller icons. A two-level type system (display and text) (Linear). **concrete**
7. **Same-document View Transitions** for list to detail ("pops out as a card, the list fades") (Things 3 behaviour, Safari 18 API). Feature-detect; respect reduced motion. **concrete**
8. **Haptics only as an explicit, tested experiment.** The `switch` trick works on iOS 18, but it is undocumented as an API and its status on newer iOS is unclear. Get owner approval before shipping. **speculative**

## Gaps
Linear's sync details and Structured's intent are secondary-sourced. Scroll-snap, safe-area and reduced-motion versions not re-verified.
