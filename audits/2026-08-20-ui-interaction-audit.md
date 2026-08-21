# Running Platform UI / Interaction Audit

- Date: 2026-08-20 22:08 (Asia/Shanghai)
- Scope: login, home dashboard, run/weight entry and history, VDOT, prediction/advice, shoe library
- Viewports: desktop 1440 x 900, iPhone 15 Pro class 393 x 852, tablet 834 x 1112
- Result: no blocking layout failure and no page-level horizontal overflow at 393 px or 834 px

## Overall Verdict

The product already has a consistent research-dashboard visual language, clear primary navigation, and stable responsive layouts. The prediction page is the strongest screen: it makes the outcome, confidence, evidence, and next action easy to scan. The remaining work is mostly interaction polish rather than a redesign.

## Priority Findings

### P1 - Mobile chart selection detail is too dense

The selected run detail is constrained to one narrow row above the chart. Date plus four metrics become very small on a 393 px screen, so the interaction works but the result is hard to read.

Recommendation: keep the current selection logic, but render the mobile detail as a two-row panel: date on the first row and metrics in a 2 x 2 grid below it. Keep values at least 12-13 px and let the panel grow vertically instead of shrinking text.

Evidence: `12-home-chart-selected-iphone.png`.

### P1 - Several mobile touch targets are below 44 px

Measured heights include: primary navigation 38 px, week/month toggle 25 px, and shoe edit/delete buttons 34 px. This increases mistaps, especially around destructive actions.

Recommendation: preserve the compact appearance but increase the effective hit area to at least 44 x 44 px. Give delete extra separation from edit and keep its confirmation step.

Evidence: `06-shoes-iphone.png`, `11-home-iphone.png`, `17-history-expanded-iphone.png`.

### P2 - The run-entry workflow is long on mobile

The form is logically ordered and the numeric fields correctly request numeric/decimal keyboards, but users must pass many optional fields before reaching screenshot upload and save.

Recommendation: keep the existing data model and split the form into visible basic fields plus collapsible optional groups for performance, environment, and notes. A sticky save action would reduce the need to scroll back to confirm progress.

Evidence: `10-record-iphone.png`, `14-record-tablet.png`.

### P2 - VDOT table horizontal navigation is not obvious

The table is stable and the header remains readable, but on mobile only the first columns are visible and the interface does not clearly signal that more columns exist to the right.

Recommendation: keep the first VDOT column sticky, add a subtle right-edge fade/chevron while more columns remain, and remove it at the scroll end.

Evidence: `07-vdot-iphone.png`.

### P2 - Shoe image failure has a poor fallback

Local preview could not load the shoe photos, leaving large empty square regions with broken-image text. This does not prove production images are broken, but the fallback state itself is weak and makes cards appear unfinished.

Recommendation: add a neutral image placeholder and loading skeleton inside the existing 1:1 container, then cross-fade to the real image. Keep shoe metrics visible even when an image fails.

Evidence: `05-shoes-desktop.png`, `06-shoes-iphone.png`.

### P3 - Mobile header consumes substantial first-screen height

Brand, five navigation items, account identity, and logout occupy roughly two header rows. It is clear but pushes task content down.

Recommendation: move account identity and logout into one account menu on mobile. Keep the five main destinations visible because they are used frequently.

Evidence: `06-shoes-iphone.png`, `09-prediction-iphone.png`, `11-home-iphone.png`.

### P3 - Desktop record page is visually unbalanced

The run form fills the left column while the small weight form sits alone at the top of a wide right rail, leaving a large empty area.

Recommendation: use the right rail for a compact OCR preview/upload queue and recent draft status, or place weight entry as a compact horizontal band above history.

Evidence: `02-record-desktop.png`.

## Screen Health

1. Login: healthy. Clear focus, strong contrast, and a straightforward login/register switch.
2. Home dashboard: healthy with one mobile readability issue in selected chart details.
3. Run and weight entry: healthy but long on mobile; optional content needs progressive disclosure.
4. History management: healthy. Monthly collapse, record cards, and edit/delete actions are easy to understand.
5. VDOT: healthy. PB expansion appears directly under the selected distance; mobile table needs a horizontal-scroll cue.
6. Prediction and advice: very healthy. Best information hierarchy in the product.
7. Shoe library: healthy grid structure; improve touch sizes and loading/error states for images.

## Accessibility Notes

- Semantic headings, navigation, buttons, form labels, expandable PB controls, and chart text alternatives are present.
- Numeric run-entry fields use appropriate `inputmode` values on mobile.
- Touch targets below 44 px are the clearest visible accessibility risk.
- Screenshots cannot verify keyboard focus visibility, screen-reader announcement timing, color contrast ratios, reduced-motion behavior, or delete confirmation behavior. These require separate interaction and automated accessibility tests.

## Evidence

Screenshots are stored in:

`C:/Users/27428/.codex/visualizations/2026/06/18/019edacb-66c6-7202-ab37-3577a76dd3f6/ui-audit-2026-08-20/`

