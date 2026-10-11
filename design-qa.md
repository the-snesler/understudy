**Findings**

No actionable P0/P1/P2 findings remain. The sidebar, Sources → Hub → Outputs composition, plugin card layout, settings controls, and sticky save bar follow the supplied references. Small differences and unavailable live-account states are classified below.

**Comparison targets and state**

Source visual truth:

| Screen | Source attachment | Source pixels | CSS comparison size |
| --- | --- | --- | --- |
| Overview | /share/userHome/quiver/.t3/userdata/attachments/88a849e3-d7ac-4bbf-b084-916236906f2e-77674458-cb47-4a78-9a13-be8c8d8e7f3f.png | 2560 × 2240 | 1280 × 1120 |
| Plex | /share/userHome/quiver/.t3/userdata/attachments/88a849e3-d7ac-4bbf-b084-916236906f2e-5fb4b77c-219b-49e0-a973-dbe7eb331bd5.png | 2560 × 4024 | 1280 × 2012 |
| Discord | /share/userHome/quiver/.t3/userdata/attachments/88a849e3-d7ac-4bbf-b084-916236906f2e-39a694eb-de1d-4bc4-b540-8828ef13fa1e.png | 2560 × 2800 | 1280 × 1400 |

Browser-rendered implementation evidence:

- Overview: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv2rs040-83c9cd2f.png — 1280 × 1120 pixels.
- Plex: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv2rmkys-f046d296.png — 1280 × 2012 pixels.
- Discord: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv2rez9h-dfdfb14f.png — 1280 × 1400 pixels.
- Mobile Overview: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv2rj9g2-d57a06eb.png — 720 × 1600 pixels at a 360 × 800 CSS viewport.
- Mobile Plex, dirty form: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv2rjg5s-88cf87d2.png — 720 × 1600 pixels at a 360 × 800 CSS viewport.

The browser reports devicePixelRatio 2. Desktop snapshot exports are reduced to 1280 pixels wide by the capture tool, giving one exported pixel per CSS pixel. The source images were displayed at half their original pixel width in the combined comparisons. Mobile captures retain their 2× density and are read at 360 CSS pixels. No browser chrome or device frame was compared.

Local implementation: http://localhost:8087/, /instances/tautulli, /instances/discord. The preview uses an isolated data directory and a local Tautulli fixture. Plex publishes “Pirate Dojo” by Toby Fox, with the Track tab selected. The desktop Plex capture has two unsaved template changes. The Discord capture has one unsaved Application ID change.

The reference is signed in to Discord; the implementation fixture is in setup state and does not impersonate a connected account. Nintendo and Steam are disabled in this fixture. Account details, history totals, warning entries, timestamps, provider artwork, and enabled states therefore differ deliberately. Comparisons of those dynamic values are excluded from fidelity judgments.

**Full-view and focused comparison evidence**

Source and implementation were rendered together in each comparison input, rather than judged from separate image views. Saved inputs, rendered through T3 html_preview:

- /tmp/understudy-design-qa/overview_comparison.html — 1500 pixels wide, two aligned full-page views.
- /tmp/understudy-design-qa/plex_comparison.html — 1500 pixels wide, two aligned full-page views.
- /tmp/understudy-design-qa/discord_comparison.html — 1500 pixels wide, two aligned full-page views.
- /tmp/understudy-design-qa/plex_focus.html — 1420 pixels wide; connection, secret replacement, interval picker, and filter fields at native CSS scale.
- /tmp/understudy-design-qa/discord_focus.html — 1420 pixels wide; online controls, disabled resend field, and Hub rules at native CSS scale.

**Comparison history**

1. Initial desktop comparison: blocked.
   - [P2] Sidebar and settings card spacing were larger than the reference, pushing more settings below the viewport. Reduced sidebar/page spacing and settings card typography, padding, field gaps, and source-row heights.
   - [P2] Plugin activity artwork was oversized, and recent-event timestamps wrapped. Set plugin artwork to 72 × 72 and prevented timestamp wrapping.
   - [P2] The save bar occupied only the settings column. It now uses the full plugin grid width, including at responsive breakpoints.
   - [P2] Disabled resend help occupied half a card. Its row spans the form, while the number input remains compact.
   - [P3] Feed paths wrapped and the last source row lost its rounded corner. Paths now truncate on one line, and row corners follow the card.
   Post-fix evidence: the final desktop screenshots and full/focused combined inputs above show these changes. The save bar and plugin grid both measured 995.203 CSS pixels wide at the 1280-pixel viewport.

2. Mobile and interaction comparison: blocked.
   - [P2] Four navigation items produced 3 pixels of horizontal overflow at 360 pixels.
   - [P2] Publishing controls were hidden on mobile, and the first mobile refinement omitted alternative pause durations.
   - [P2] Live replacement could remove a focused reorder control or open menu.
   Fixes: compact navigation spacing; a mobile publishing card with all duration options; suppress live swaps during drag, focused interaction, and open menus.
   Post-fix evidence: final mobile captures above; document scrollWidth and viewport both measured 360 pixels. The dirty save bar stayed within x=16..344 and ended at y=792 in an 800-pixel viewport. The reorder menu and focus survived a polling interval.

3. Final color and state review: passed.
   - [P2] Small activity-kind text reused bright chart colors with insufficient contrast. Separate darker text tokens now preserve the chart palette while improving text contrast. Warning text also uses a darker ink token.
   - [P2] Discord setup state described headless mode even with “Only while I’m on Discord” enabled. It now describes the configured mode.
   Post-fix evidence: final Plex/Overview captures show the darker activity labels; the final Discord capture reports the correct mode. All UI palette literals are centralized in @theme. Browser-computed canvas, card, and Hub colors remained rgb(243,243,239), rgb(255,255,255), and rgb(237,246,245).

Capture failures caused by restarting the fixture server and previously cached CSS were discarded. They are preview troubleshooting, not accepted QA evidence.

4. Follow-up totals, rules, and readability review: passed.
   - Watching, listening, and playing now union non-paused source intervals per kind. Duplicate Plex/Trakt observations followed by paused media count as 10 active minutes; paused activity confirmed by an output still counts toward Displayed.
   - Output summaries use the same effective values as their editable fields. Each field identifies inheritance or an explicit override, including empty quiet hours and overrides equal to the Hub value.
   - Page rendering lives in `src/web/pages/`, with shared activity, history, events, instance actions, page headers, rules, and save-bar components in `src/web/components/`. The extraction preserved HTML and response status across 15 routes.
   - A fresh isolated preview at http://localhost:8088/instances/discord used Hub quiet hours 23:00–07:00 and partial output overrides (`paused: show`, `quietHours: ''`). Both summary and fields showed Show / Off / America/Chicago; priority and time zone were labeled inherited.
   - Desktop evidence: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv35hfv9-d48bf684.png — 1280 × 800 pixels. Mobile evidence: /share/userHome/quiver/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mv35iaay-d5ec3d3c.png — 720 × 1600 pixels at a 360 × 800 CSS viewport. The mobile card measured x=16..344; document and viewport widths were both 360 pixels. No console errors or failed network requests appeared.
   - Full suite: 248 tests across 20 files passed. Typecheck, production build, and diff check passed.

**Required fidelity surfaces**

- Fonts and typography: Geist and Geist Mono load locally; browser font checks passed. Heading weight, compact labels, monospace timestamps/templates, and wrapped helper copy were inspected in the focused comparisons. The user explicitly requested these fonts; no external font requests are used.
- Spacing and layout rhythm: sidebar proportions, page gutters, two-column grids, rounded cards, source ordering, connector lines, section spacing, and save-bar placement were reviewed at matching desktop sizes and at 360 pixels. Remaining card-height differences are small or arise from preserved settings.
- Colors and tokens: light canvas, warmer sidebar, white cards, teal Hub, pastel plugin tiles, green success, and dark save bar follow the references. Chart colors and readable text colors have separate theme tokens.
- Image quality and asset fidelity: the existing Understudy mark is retained. Lucide and Simple Icons render their library SVG data on the server, as requested; brand logos intentionally replace the mock’s generic plugin symbols. The fixture has no external cover artwork, so the reference’s dark music tile is represented by the matching library music icon. Real remote cover-image loading was not exercised.
- Copy and content: card titles, breadcrumbs, save/restart consequences, template help, setup instructions, rules inheritance, feed access, and empty/setup states were reviewed as standalone app copy. Actual status and history values are used.

**Primary interactions and verification**

- Keyboard Move up/down persisted source order and was restored after the check.
- Reorder focus and its open menu survived a live polling interval.
- Track selection and tab keyboard navigation worked.
- Variable insertion replaced the selected text in the last focused template field.
- Current-stream template previews rendered “Pirate Dojo” and “Toby Fox.”
- Output overrides revealed enabled fields; Discard hid them and reset dirty state.
- “Only while I’m on Discord” disabled the resend control.
- Dirty counts, Discard, secret replacement, chips, and suggestions were checked in the implementation and delegated browser tests.
- Copy fallback selected the complete token-bearing feed URL when Clipboard API access and legacy copy were unavailable.
- Mobile navigation, publishing durations, settings fields, and save actions remained accessible without horizontal overflow.
- The clean final browser tab showed no console errors or failed network requests after polling. Earlier connection-refused errors corresponded to intentional fixture restarts.
- Full suite: 238 tests across 19 files passed. After the final UI changes, 26 affected tests passed. Typecheck and production build passed.

**Accepted differences and follow-up polish**

- [P3] Some settings cards are slightly taller than the mock. Plex retains the existing “View on Plex” control and an explicitly labeled TMDB key field; Discord also displays the rules’ time zone. These controls preserve working functionality and make the configured schedule clear.
- Source priority is global instance order. Per-output overrides cover paused media and schedules; they do not introduce a second priority list.
- The timeline intentionally remains a stub, as authorized; recording, totals, and feeds are implemented.
- Live Discord sign-in, actual remote artwork, and real calendar subscriptions were not exercised in browser QA. Transport, authentication, feed tokens, stable calendar UIDs, restart recovery, retention, and time-zone/DST behavior have automated coverage.
- Warn/error logs remain the existing memory buffer. Warning dismissal persists; saving the log itself was optional and is not implemented.

**Implementation checklist**

- [x] Source and implementation captured and compared together.
- [x] Full-view and readable focused comparisons completed.
- [x] P0/P1/P2 findings fixed and checked again.
- [x] Desktop/mobile interactions and console diagnostics checked.
- [x] Tests, typecheck, and build passed.
- [x] Residual differences and test limits documented.

final result: passed
