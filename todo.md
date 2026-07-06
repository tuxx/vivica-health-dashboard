# TODO

## Deployment

- [x] **docker-compose.yml** — `docker compose up -d` runs the server
  straight from the stock `node:22-alpine` image with the repo bind-mounted
  in (`.:/app`); no Dockerfile, since there's no build step or npm install
  to bake into an image. `data/` (session + SQLite cache) is part of the
  same mount, so it lives in the repo directory and survives restarts.
  `PORT` still works as an env var for anyone running outside Docker. No
  image is published to a registry — the app is small enough that this is
  simpler than maintaining a GHCR release pipeline.

**Low priority**

- [ ] **Multi-user / multiple concurrent sessions** — right now the server
  holds exactly one Vivica session (`data/session.json`, a single top-level
  `session` variable in `server.js`) for the whole process; logging in as a
  different account replaces it. Making this multi-user means per-browser
  session identity (cookies + a session store keyed by browser session, not
  a single global variable) and keeping each user's token/SQLite cache
  scoped to them instead of shared globally.

## Further usability ideas

- [ ] **Favorites/pins bar** in the log-food modal (beyond Recent/Frequent) —
  one-click re-log of a small pinned set (e.g. "my usual coffee") without
  typing a search at all. Could piggyback on `is_favorite` for meals.
- [ ] **Numeric keypad-friendly quantity entry**: amount/serving inputs are
  plain `number` inputs; on desktop, arrow-key nudge with a sane step, and
  remembering last-used amount per product, would speed up repeat entries.
- [x] **Command palette (`Ctrl`/`Cmd`+`K`)** — `#palette-modal` in
  `app.js`/`index.html`. Static navigation commands (Food Log, Profile,
  Settings, Log food, Build a meal, Copy from another day, Keyboard
  shortcuts) filtered by substring match; once the query is 2+ characters a
  debounced live product/meal search (same `/nutrition/search` endpoint)
  appends below a "Products & meals" label. Picking a product opens the log
  modal straight to that item's log-it form. Verified open (Ctrl+K),
  filtering, arrow-key nav, and Enter-to-select against the real account.
- [ ] **Undo toast** after logging/deleting an item (a few seconds to undo)
  instead of only a confirm-before-delete — reduces friction on the common
  "oops, wrong item" case without removing the safety net entirely.
- [ ] **Barcode/photo entry** — nothing in the reconstructed API suggests
  client-side barcode scanning (search takes text), but worth checking if a
  `gs1`-type search-by-code exists; would remove typing entirely for packaged
  food.
- [ ] **Day-part totals reflect goal status at a glance** — the day panel
  already shows totals vs. goal, but color-coding (e.g. red/green tile border)
  would make over/under status scannable without reading numbers.
- [x] **Nutrient tiles are now collapsible** — the 5-tile grid (Energy,
  Protein, Fat, Carbs, Fiber) is hidden by default so the day's logged
  items are the first thing visible. A new `#day-totals-section` wrapper
  (`index.html`) sits around `#day-panel-totals` specifically so the
  collapse state survives `renderDayPanel()`'s `innerHTML` rebuild on every
  day switch/refresh — only the tiles inside get rebuilt, the wrapper's
  `collapsed` class doesn't. Its always-visible toggle header shows a
  compact Energy summary ("754 / 2961 kcal" + a mini `.tile-bar`, same
  fill-percent/`over-goal` logic as the full tile, factored into
  `tileBarFillPercent()` in `calendar.js`) with a rotating chevron.
  Collapsed/expanded choice persists across reloads via a new
  `totalsCollapsed` key in `DEFAULT_SETTINGS` (`shared.js`) — same
  `saveSettings()`/`localStorage` pattern as theme/time-format/etc. Defaults
  to collapsed for a first-ever visit. Verified fresh-load-collapsed,
  toggle open/close, persistence across reload, and staying expanded (with
  correct updated values) when switching days — all against the real
  account.
- [ ] **Remember last day-part override per session** — if the user overrides
  the guessed day-part once, reuse that override for subsequent logs in the
  same sitting instead of re-guessing each time.
- [x] **Main nav renamed "Calendar" → "Food Log"**, with a new list icon —
  the old calendar-grid glyph/label was left over from before the day-view
  redesign. Display text and icon only; internal identifiers
  (`data-tab="calendar"`, `calendar.js`, `showTab('calendar')`) are
  unchanged. Updated everywhere the label appears: sidebar, shortcuts
  modal, Settings page, command palette.
- [x] **Collapsible desktop sidebar** — a toggle in the `.brand` row shrinks
  the sidebar to a 72px icon-only rail (`--sidebar-width-collapsed` in
  `style.css`), hiding labels and stacking the footer icons vertically.
  Same `saveSettings()`/`localStorage` pattern as `totalsCollapsed`, via a
  new `sidebarCollapsed` key in `DEFAULT_SETTINGS` (`shared.js`). Gated
  behind `@media (min-width: 761px)` so the mobile top-bar layout
  (`max-width: 760px`) is completely untouched. Verified toggle,
  reload-persistence, nav/footer routing while collapsed, and that mobile
  width always shows the original full bar with the toggle hidden.

## Settings page (done)

- [ ] Not covered yet: the `#log-date`/native `<input type="date">` picker's
  format still follows the browser/OS locale (can't be overridden portably);
  the calendar month label (e.g. "July 2026") is still always long-form.
- [ ] Settings changes take effect live (a `vivica:settings-changed` event
  re-renders the calendar/time inputs) but there's no "reset to defaults"
  button yet.

## Bring the rest of the Vivica API into the dashboard

The server only wraps nutrition/meal logging today (see `server.js`). `API_REFERENCE.md` documents a lot more of the upstream API that isn't exposed in the UI yet:

- [ ] **Chat** — messaging with care team.
- [ ] **Lifestyle plan / Treatment plans**.
- [ ] **Tasks / Tiny Habits**.
- [ ] **Activities & Goals**, **Exercise / Cardio / Interval Sessions**.
- [ ] **Appointments** (Group / Personal Training & Appointments).
- [ ] **Articles** and **Information Tips** / **Module Lessons**.
- [ ] Other sections worth a look: Pain Scores, Side Effects, Mental Health, Sleep Relaxations, Medications, Patient Photos & File Uploads, Questionnaires, Patient Registrations (Biometrics), Graph Data, Lab Tests, Ekomenu Recipes.
- [ ] For each: add server routes in `server.js` (mirroring the existing `/api/nutrition/*` pattern) and a corresponding view/tab in `public/`.

## Interface polish

- [ ] General visual/UX pass once more features land — current styling was built just for the nutrition flows.
- [ ] Loading/empty/error states consistency across new views.
