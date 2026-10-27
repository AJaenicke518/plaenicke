# Contrast and toast gap (2026-10-26)

Branch `contrast-and-gap`. Both changes approved by Alex 2026-10-26. CACHE not bumped.

## 1. --muted contrast

Method: hue and saturation held (HSL), lightness stepped 0.25% at a time until the ratio on --bg and --card reached 4.5. WCAG 2.x relative luminance, same formula as the test helper.

| Theme | Before | After | on --bg | on --card | on --chip-bg (pressed row) |
|---|---|---|---|---|---|
| light | #8a8070 | #766d5f | 3.45 -> 4.52 | 3.82 -> 5.01 | 3.21 -> 4.21 |
| dark | #7d828c | #838891 | 4.70 -> 5.09 | 4.19 -> 4.53 | 3.73 -> 4.04 |

Dark was NOT already passing: 4.19 on card is below 4.5, so it was fixed the same way (lightened, since the surface is dark).

Pressed row (--chip-bg): both themes stay below 4.5 (4.21 light, 4.04 dark) with the minimal change. The pressed tint is transient (held while a finger is down). Reaching 4.5 there needs light #71685b (4.53 on chip, 4.86 bg, 5.39 card) and dark #8c9099 (4.50 chip, 5.66 bg, 5.05 card). Not applied, since the brief set bg and card as the target. Alex's call.

Tests (`tests/styles.test.js`): `--muted reads at WCAG AA (4.5:1) on --bg and on --card`, both themes, values read from styles.css.
Mutation: restoring both old --muted values failed both new tests (44, 45); restored.

## 2. Toast gap

Body padding-bottom: `calc(56px + 72px + inset)` -> `calc(56px + 80px + inset)`. Comment updated; spec section 4 carries a 2026-10-26 note quoting "yes".

Arithmetic (all measured up from the viewport bottom, so the inset cancels):
- toast bottom = 56 + 12 = 68px
- toast height = 62px (one line: 44 + 16 + 2) or 66px (two lines)
- toast top = 130px or 134px up
- old band 56 + 72 = 128px: 2px and 6px short, so the toast covered 2-6px of the last row
- new band 56 + 80 = 136px: clears by 6px (one line) and 2px (two lines)

Tests: the pinned padding test updated to 80px; a new test computes the band and the toast top from styles.css and asserts band >= toast bottom + 62 and + 66.
Mutation: restoring 72px failed both (18, 19); restored.

## Gate
`npm test`: tests 1538, pass 1538, fail 0, cancelled 0.

## Review
No independent reviewer was dispatched; one agent did the work. No independent review happened.
