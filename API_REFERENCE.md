# Vivica API Reference

Reverse-engineered from `Vivica_1.63.0.xapk` (webpack source maps with `sourcesContent`, 
reconstructed under `extracted/reconstructed_src/src/`). This document covers the 
**full** API surface found in the reconstructed client (190 unique endpoint call
sites across the whole app), not just nutrition.

Everything below was derived by reading the actual `.vue`/`.js` source and
noting exactly which request fields are sent and which response fields the
client reads — not guessed from naming conventions. Field names, required-ness,
and behavior quirks are as observed in the code.

## Conventions used in this doc

- `${x}` in a path = a path parameter substituted client-side.
- "Response fields read" lists only what the client actually consumes off
  `res.data` — the server may return more.
- Bodies are shown as the literal JS object sent (post-serialization to JSON).
- Unless noted otherwise, calls go through a shared `axios`/`window.axios`
  instance with the base URL and headers described below.

## Base URL, headers, auth

- `app_url`: `https://dashboard.vivica.health` (config.js) — the web/Capacitor shell.
- `api_url`: `https://api.vivica.health` — all endpoints below are relative to this.
- CORS: API reflects any `Origin` and sends
  `Access-Control-Allow-Credentials: true` — callable directly from a browser,
  no server-side proxy required for CORS purposes.

**Required on every request** (`helpers/InitAxios.js`, set once at boot):

| Header | Source | Notes |
|---|---|---|
| `Native-Application-Version` | `App.getInfo().version` (Capacitor), fallback `window.application_version` | **Undocumented gate** — omitting it returns `403` "app update required" *before* credentials are checked, even on `/auth/login`. |
| `Application-Version` | `CapacitorUpdater.current()` bundle version if it matches `\d{1,3}\.\d{1,3}\.\d{1,3}`, else falls back to `Native-Application-Version` | |
| `Bundle-Id` | Capacitor updater bundle id | |
| `Cap-Update-Id` | Capacitor updater update id | |
| `Application-Theme` | default `"vivica"` | |
| `Use-Language` | `localStorage['device-locale']` / `['language-used']` | Also updated after `/translations/application/${locale}` responds. |
| `X-Requested-With`, `Accept: application/json`, `Content-Type: application/json`, `withCredentials: true` | axios defaults | |
| `Authorization: Bearer <access_token>` | set in `store/Authentication.js` `setAccessToken` mutation | Persisted to `localStorage['user-token']`. |

**Auth flow:**

- `POST /auth/login` — `{ email, password, authCodeRequested, token, lang }`.
  - `token` is a 2FA/TOTP or emailed OTP code. A `422` with
    `message === "auth_code sent"` switches the UI into "enter emailed code"
    mode; `message === "google_auth_code expected"` switches to authenticator-app
    mode. A 6-digit `token` auto-submits.
  - `403` clears the password field (distinct from bad-credential `422`s) —
    this is the same status code returned by the missing-header gate above,
    so a `403` here doesn't necessarily mean bad credentials.
  - Response: `user`, `mobile_menu_items`, whole payload → general app data,
    `server_settings`, `access_token`, `permissions` (checked for
    `'feature_module.mocia'` to pick the post-login route).
- `POST /auth/me` — no body. Refetches `user`, `mobile_menu_items`, general
  app data. On failure, the store dispatches a forced logout.
- `POST /auth/logout` — no body. Clears token/user/general-data client state
  and `localStorage['user-token']`; response gives fresh `server_settings`.
- `POST /auth/agree` — `{ agreement_privacy_declaration, agreement_use_medical_personal_data }`
  (booleans). Response `user` → routes to `tasks`.
- `POST /auth/forgotten_password_link` — single endpoint driving a 3-screen
  wizard via `screen_index` (0/1/2) and `res.data.message`:
  `{ screen_index, email, token, new_password, new_password_confirmation }`.
  - `"mail_sent"` → advance to token-entry screen.
  - `"token_accepted"` → advance to new-password screen.
  - `"password_changed"` → redirect to `login` prefilled with the new password.
  - Anti-enumeration: an `unknown_user` error still advances to the token
    screen instead of revealing the email doesn't exist.
- `POST /auth/security/change_password` — `{ password, password_confirmation }`.
  Client gates the submit button on a password-strength regex before sending.
- `POST /auth/update_fcm_token` — `{ fcm_token, device_information }`, only
  sent once a user is logged in and `window.fcm_token` is set.

---

## Consents & Privacy

- `GET /auth/gli_consents` — no params. Response `consents`: object keyed
  `consent-1`..`consent-5`, each `{title, body}` (HTML).
- `POST /auth/update_gli_consents` — bulk submit for the first-time consent
  wizard (shown when `user.waiting_for_gli_consent`):
  `{ consents: { 'consent-1': true|false|null, ..., 'consent-5': ... } }`.
  Response `user`.
- `POST /auth/gli_consent` — single-consent update from the Privacy screen
  (revisiting one consent later): `{ name: 'consent-2', value: boolean }`.
  Response `user`.
- `GET /auth/patient_consents` — practice-specific consents. Response
  `consents[]`: `{id, title, description, questionnaire_name, links, pdf_url,
  pdf_name, history: [{timestamp, accepted, actor_type}]}` — current state is
  the last `history` entry's `accepted`; `actor_type` containing
  `'App\Models\User'` means a clinician decided on the patient's behalf.
- `POST /auth/patient_consents/${id}/update` — `{ accepted: boolean }`.
  Response `consents[]` replaces the *whole* list (not just the changed item).
- `POST /auth/settings/privacy_medical_personal_data` — `{ state: boolean }`
  (approve/deny/withdraw medical-data-use agreement). Response `user`.
- `GET /auth/medical_form` — no params. Response `data`: `cancer_type_id`,
  `menopausal_id`, `tumor_informations[]` (per side `left`/`right`:
  `diagnoses_ids`, `tumor_stage_id`, `multifocality`, `tumor_size_id`,
  `nodal_stage_id`, `metastasis_id`, `date`), `treatments[]`
  (`treatment_id`, `start_date`, `end_date`, `medication_id`),
  `medications[]` (`name`, `start_date`, `end_date`, `dosage`).

## Push Notifications & Health Sync

- `POST /auth/change_tiny_habit_push_notification_state` — `{ state }`, note
  the client sends the **inverse** of the toggle shown (UI toggle = "enabled",
  API field = "disabled"). Response `user`.
- `POST /auth/change_medication_push_notification_state` — same pattern,
  `{ state }` inverted. Response `user`.
- `GET /auth/mobile-device-notifications?fcm_token=<token>` — only called if
  `window.fcm_token` is set. Response: object keyed by `"DD-MM-YYYY"` →
  array of `{id, title, body, sent_at_time, data}`; clicking one emits a
  deep-link event using `data`.
- `POST /auth/health_sync_enabled` — `{ state: boolean }`, confirmed via
  native `confirm()` before disabling. Response `user`;
  `user.health_sync_enabled_at` gates whether per-item sync toggles are shown.
- `POST /auth/health_sync` — the actual HealthKit/Google Fit sync payload,
  built from `navigator.health` queries (`helpers/healthSyncMixin.js`):
  ```js
  { [internalType: string]: Array<HealthSample> }
  // internalType ∈ height, weight, fat_percentage, saturation_in_peace,
  // waist_circumference, vo2max_default, glucose_value,
  // blood_pressure_in_peace, heart_rate_in_peace, steps, stairs, distance,
  // temperature, calories, calories_active, calories_basal
  ```
  Optional `checkOnlyTypes` param restricts which types are queried (used
  right after a single type is freshly enabled). Only fires with network
  connectivity, a logged-in user, `health_sync_enabled_at` set, and
  `navigator.health` present; each native query has a 5s fail-open timeout.
  Response values (not keys) are localized via `$t('form.' + item)` and shown
  in a success toast.

## Company & External Users

- `GET /auth/company_info` — response `data`: `name`, `avatar_lg_url`/
  `avatar_normal_url`, `email`, `phone`, `addresses[]`, `users[]` (each with
  `pivot.role_id`, `pivot.fallback_role_display`, `deleted_at`), `roles[]`
  (`id`, `name`, `color`, `is_visible`), `has_introduction`.
- `POST /auth/complete_company_introduction` — no body. Response `user` sets
  `selected_company.settings.introduction_completed_at`.
- `GET /auth/personal_users` — response `data[]`, filtered client-side to
  exclude `is_owner`; `allowed_external_user_ids` seeded from entries with
  `patient_confirmed_at`. Items: `patient_confirmation_required`,
  `patient_confirmed_at`, `pivot.role_id`, `pivot.fallback_role_display`,
  `thumb_md_url`.
- `POST /auth/settings/external_users` — grants/revokes which external users
  (e.g. HCPs) can see the patient's data: `{ allowed_external_user_ids: number[] }`.
  Response `user`.
- `POST /auth/set_hcp_user` — approve/deny an external user's access request,
  from a queue (`user.remaining_users`, one shown at a time):
  `{ user_id, state: boolean }`. Response `user` + general data; re-emits the
  approval-check event after 500ms to pop the next queued user.
- `POST /auth/set_external_user_permission` — `{ user_id, state: boolean }`
  (route-driven, `CompanyUserInfo.vue`). Response `user` + general data,
  routes to `index`. Note: no `.catch`, so a failed request can leave
  `content_loading` stuck `true`.

## Chat

- `GET /chats` — conversation list. Response used wholesale; unread badge
  count computed client-side as the sum of `unread_messages` across
  `available_users[]`, `available_groups[]`, `available_companies[]`.
- `POST /chat` — fetch messages for a conversation (body fields not fixed in
  `store/Chat.js`, passed through from caller). Response: an array (initial
  load, replaces state) or a keyed object (incremental merge, de-duplicated
  by `id` before appending) — client-side pagination.
- `POST /chat/send_message` — body passed through from caller. Response: a
  single message object, appended directly to local state.
- `DELETE /chat/${id}` — `id` = message id. Response unused; local list isn't
  updated by this call (presumably relies on a subsequent re-fetch).
- `POST /chat_settings/update_nickname` — `{ nickname: string }`. Response
  `user`.

---

# Nutrition & Meal Logging

Fully documented in `CLAUDE.md` (this was the original focus of the
reverse-engineering effort, and is what the local `dashboard/` app drives).
Summary — see `CLAUDE.md` for full detail on quantity math and the
`response_cache` TTLs used by the dashboard backend:

- `POST /patient/nutrition/search` — `{search, brand, supermarket, page,
  type, meal_tab}` → paginated results, 10/page.
- `POST /patient/nutrition/item_data` — `{type, id, current_time}` → product
  detail (`conversions`, `values`, `thumb_url`, `suggested_day_part`,
  `suggested_nutrient_conversion_id`).
- `POST /patient/nutrition/submit_item` — the actual "log food" call; merges
  the item_data response with `date`, `time`, `day_part`, `specify_method`
  (`manual`/`conversion`), `amount_value` or `selected_conversion_id` +
  `amount_pieces`, and (for meals) `meal_amount`.
- `POST /patient/nutrition/duplicate_items_to_date` — copy a day's items to
  another date.
- `POST /patient/nutrition/delete_scheduled_item` — remove a logged item.
- `POST /patient/nutrition/stats` — `{date}` → day's items grouped by
  `day_part` + totals (the "today" screen's read side).
- `POST /patient/nutrition/nutrient_product_create` — create a custom
  product, then log it via the normal flow.
- `GET /patient/nutrition/supermarket_types` — filter options for `search`.
- `GET /patient/nutrition/has_nutrition_days` — used by the "copy day" picker.
- `GET /patient/nutrient_items/` — referenced by the client (item list); see
  reconstructed source for exact usage if extending the dashboard.
- `POST /patient/scheduled_nutrient_item/` — scheduled-item variant of
  submit/logging (used from `NutrientScheduledItem/Complete.vue`).
- `POST /patient/nutrient_goals_data` / `POST /patient/nutrient_goals_data_submit`
  — nutrient goal setup, fetched/submitted from the Nutrition index page.

**Meals** (first-class "combo of products" concept):

- `POST /patient/search_nutrient_products` — `{query}` → simple product
  search for building a meal (distinct from the daily-log search above).
- `POST /patient/submit_nutrient_meal` — create a meal: `{name, day_part,
  time, is_favorite, items: [{target_id, product_item_amount,
  product_amount, nutrient_product, conversion}]}`. Quantity math:
  `product_item_amount = round(product_amount / product.amount, 3)`.
- `GET /patient/nutrient_meals/${id}?include=nutrient_products` — fetch for
  editing.
- `POST /patient/update_nutrient_meal/${id}` — update (same shape as create).
- `POST /patient/nutrient_meals/${id}/set_favorite` — toggle favorite.
- `POST /patient/hide_nutrient_meal/${id}` — hide/delete a meal.
- Log a meal like any item: search (`type: 'meal'`) or `item_data`
  (`type: 'nutrient_meal'`) → `submit_item` with `type_record: 'meal'` and
  `meal_amount` (fraction: 1, 0.75, 0.5, 0.25).

---

# Activities & Goals

- `GET /patient/activity_types` — catalog for logging a new activity.
  Response `data[]`: `{id, name, settings: {duration_enabled,
  distance_enabled, distance_unit, steps_enabled, stair_steps_enabled}}`
  (client overwrites `name` with a translation key and sorts alphabetically).
- `POST /patient/create_activity` — `{date, activity_type_id, description,
  duration_minutes, steps, distance, is_future, feedback: {intensity, steps}}`.
  `feedback` only populated for the "today" flow (vs. "schedule for later").
  Response `id` → routes to activity feedback.
- `GET /patient/activity_archive` — full activity history, both completed and
  not; filtering/sorting (`mode`, sort field) is entirely client-side, no
  query params sent.
- `GET /patient/activity/${id}` — single activity detail: `created_by`
  (falsy ⇒ user can delete/finish it), `intended_date`, `description`,
  `activity_type.{id, thumb_url, settings}`, `settings.{duration,
  duration_seconds, distance, unit, steps, feedback}`.
- `DELETE /patient/delete_activity/${id}` — confirm-gated, uncompleted
  activities only. Routes to `tasks` on success.
- `POST /patient/activity/${id}/complete_activity` — `{feedback: {intensity,
  duration, distance, recovery_time, steps}}`; an intensity VAS-slider step
  is shown first only if `settings.feedback.intensity` is true.

**Goals** (`pages/Goals/Index.vue` — biometric goals, activity goals, and
"custom goals" tabs):

- `GET /patient/goals_data` — the whole goals overview:
  `treatment_plan_goals`, `biomedical_data`, `biometric_values`,
  `registrations` (keyed by biometric type, `[{date, value:{value}}]`),
  `last_registrations`, `first_registrations`, `treatment_plan_id`,
  `activity_goals[]` (`{id, activity_type_id, settings: {distance_goal,
  duration_goal, steps_goal, distance_unit}}`), `activity_types[]`,
  `activity_registrations[]`.
- `POST /patient/update_goal_value` — `{type, value}` (biometric goal, e.g.
  weight). Response `treatment_plan_goals`.
- `POST /patient/create_activity_goal` / `POST /patient/update_activity_goal/${id}`
  / `DELETE /patient/delete_activity_goal/${id}` — body
  `{activity_type_id, distance_goal, duration_goal, steps_goal, start_date,
  end_date}` (+ `id` on update). All three respond with the refreshed
  `activity_goals[]`.
- `POST /patient/create_custom_goal` / `POST /patient/update_custom_goal/${id}`
  / `DELETE /patient/delete_custom_goal/${id}` — a "custom goal" is a
  1–10-daily-score habit goal: `{name, start_date, end_date, baseline,
  frequency_days[], frequency_interval, goal}`. All respond with refreshed
  `customGoalsData`.
- `GET /patient/goals_custom_goals_data` — lazy-loaded when the custom-goals
  tab is opened: `{data[], frequency_days_options[], frequency_interval_options[]}`.
  `data[]` items: `{id, name, baseline, goal, last_value, days_left,
  end_date_passed, start_date, end_date, frequency_days, frequency_interval,
  values, graph}`.
- `GET /patient/patient_custom_goals_stats/${date}` — the day's custom-goal
  check-in items (`components/MainMenu/ScheduledCustomGoalsOverlay.vue`).
  Response `data[]`: `{name, value}` (value 1–10, filled by the user).
- `POST /patient/patient_custom_goals_update_states` — `{intended_date,
  items[]}` — submits the day's filled-in values; client requires every item
  to have a truthy `value` before allowing save.
- `GET /me/goals` / `POST me/goals` — oncological/custom "check-in" goals
  (`pages/InputGoals/Show.vue`), keyed by a `type` route param
  (`oncological_goals` | `custom_goals`, redirects to `tasks` for any other
  value). GET response: `data[type]` → `[{id, goal_id, title}]` (client
  injects `value: {index: 0, value: 1}` default). POST body: `{intended_date,
  goals: [{id, goal_id, value: {index, value}}], type}`.

# Exercise / Cardio / Interval Sessions

- `GET /patient/exercise_session/${id}` — a strength session containing
  multiple exercises: `{id, name, can_change_date, new_intended_date,
  redirect_feedback, intended_date, guideline, exercises: [{id, name,
  thumb_url, completed, completed_at}], completed_exercises_count,
  exercises_count, feedback_settings: {intensity}}`. `redirect_feedback`
  true ⇒ auto-redirect straight to the feedback flow.
- `POST /patient/exercise_session/${id}/update_event_date` — `{intended_date}`
  reschedules the session; errors are silently swallowed.
- `POST /patient/exercise_session/${id}/complete_session` — `{feedback:
  {intensity}}`; auto-called with no user interaction if
  `feedback_settings.intensity` is falsy.
- `GET /patient/exercise/${id}/${session_id}` — a single exercise within a
  session, for per-exercise feedback: `settings.sets[]` (`{type: 'kg'|'lbs'|
  'bands'|'elastic'|'body_weight'|'none'|'%1rm', type_value, unit,
  unit_value}`), `settings.feedback: {reps_and_weight, reps_in_reserve,
  intensity}`; top-level `settings: {bands_values[], elastic_values[]}`.
- `POST /patient/exercise_session/${session_id}/complete_exercise` —
  `{exercise_id, feedback: {finished, reps_and_weights, reps_in_reserve:
  '0'|'1'|'2'|'3'|'>3'|null, intensity, tempIntensity}}`; which sub-fields
  are collected depends on the exercise's `feedback` flags.
- `GET /patient/cardio_session/${id}` — machine-based cardio (bike/treadmill):
  `{id, name, intended_date, cardio_type: {name, image}, guideline,
  duration_minutes, settings: {watts, bpm, intensity: each
  {enabled, value: {start, end}}, feedback: {duration, effort_experience,
  watt_bpm_intensity}}}`.
- `POST /patient/cardio_session/${id}/complete_session` — `{cardio_session_id,
  feedback: {duration, effort_experience, watt_bpm_intensity: {watts, bpm,
  intensity} each {start, end}, duration_expanded, duration_minutes_total,
  duration_minutes_remaining}}`.
- `GET /patient/interval_session/${id}` — HIIT-style high/low zone session:
  `{id, intended_date, interval_type: {name, image}, guideline,
  amount_of_sets, settings: {high, low: each {duration_seconds, watts, bpm,
  intensity}, feedback: {finished, effort_experience, watt_bpm_intensity}}}`.
- `POST /patient/interval_session/${id}/complete_session` —
  `{interval_session_id, feedback: {sets_total, sets_remaining, finished:
  {value, sets}, effort_experience, watt_bpm_intensity: {low, high} each
  {watts, bpm, intensity} each {start, end}, duration_expanded}}`.

# Group / Personal Training & Appointments

- `GET /patient/group_training/${id}` / `GET /patient/personal_training/${id}`
  — response `data` → training object (used inside a shared
  `InvitationPartial`), at minimum `intended_date`.
- `POST /patient/group_training/${id}/complete_training` /
  `POST /patient/personal_training/${id}/complete_training` — no body,
  routes to `tasks` on success.
- `GET /patient/appointment/${type}/${id}` — generic appointment overlay
  (covers group/personal/open-meeting kinds via the `type` param): `{name,
  description, language, can_cancel, video_url, image_url, date_str, time,
  appointment_type, address: {street, number, postcode, city, country,
  name}, participants, external_link, complete_url, complete_button_text,
  has_attended, can_attend, is_full, id, type, intended_date, sub_title}`.
- `POST {appointment.complete_url}` — the completion URL is server-supplied
  (not a fixed path); no body.
- `POST /patient/open_meeting_attend/${id}` — no body. Response `data`
  replaces the appointment object (updated attendance state).
- `POST /patient/open_meeting_cancel/${id}` — `{reason}` (from a native
  `prompt()`). Response `data` replaces the appointment object.
- `GET /patient/group_appointment/${id}` / `GET /patient/personal_appointment/${id}`
  — same shape as the generic appointment fetch; `parent_model.image_url`
  is copied to `thumb_url`, `parent_model.vimeo_video_id` to `video_url`.
- `POST /patient/group_appointment/${id}/complete_appointment` /
  `POST /patient/personal_appointment/${id}/complete_appointment` — no
  body, routes to `tasks` with `date: intended_date`.

# EiFit (Protein Tracking)

All keyed by `${date}` (`YYYY-MM-DD` route param):

- `GET /patient/eifit/${date}` — response used directly (no `.data` wrapper):
  `settings` (`introduction_text`, `open_goal_overlay`,
  `can_close_goal_overlay`, `gender_options`, comparison snapshot of
  `age/gender/weight/height`), `goal` (`age, gender, weight, height,
  use_default_goal, different_protein_goal`), `categories[]` (`{id, name,
  icon, items: [{id, name, image_path, requires_custom_input,
  formatted_plant_based_proteins, formatted_animal_proteins}]}`), `stats`
  (`current`, `goal`, plant/animal splits + goal percentages), `items`
  (grouped eaten products for the day).
- `POST /patient/eifit/${date}/assign` — add an eaten item: `{intended_date,
  item_id, amount, name, animal_proteins, plant_based_proteins}` (last three
  only for custom items). Response: full state object, same shape as GET.
- `POST /patient/eifit/${date}/submit_goal` — `{...goal fields,
  intended_date}` (spreads the whole goal object). Re-fetches stats after.
- `POST /patient/eifit/${date}/submit_copy` — copy eaten items to another
  date: `{intended_date: targetDate, selected_items: [{id, amount}]}`.
- `POST /patient/eifit/${date}/update` — update/remove eaten items:
  `{intended_date, selected_items: [{id, amount}]}` — `amount: 0` deletes
  server-side. Response: full state object.

---

# Appointments — see above (Group / Personal Training & Appointments)

# Pain Scores

- `GET /auth/pain_scores` — response `data[]`: `{id, name, sub_title,
  description, locked, activated}` — which pain-score "questions" are
  active for this patient (toggle-list UI).
- `POST /auth/pain_scores/toggle` — `{question_id, state}`. Response `data[]`
  — full refreshed list, not just the changed item.
- `GET /auth/pain_score_stats` — response `data`: `pain_score_settings.
  questionnaire.questions[]`, `pain_score_feedbacks[]` (`{intended_date,
  completed_at, data: {answers: {[question_id]: {value}}}}`). Client
  computes per-question graphs/tables and checks company threshold-alert
  settings (`good_to_bad`/`bad_to_good`) locally.
- `POST /patient/pain_score_create` — `{date}` — find-or-create today's
  session. `message === 'no scores registered'` → redirect to index;
  otherwise `res.data.id` → navigate to the fill-in screen.
- `GET /patient/pain_score/${id}` — response `data` → `pain_score`,
  `questions[]`, and `data.patient_pain_score.questionnaire`.
- `POST /patient/pain_score/${id}/complete_pain_score` — `{questions,
  answers}` (answers array index-aligned with questions; value shape
  depends on question type — range index, choice value(s), or text).
- `POST /patient/pain_score_delete/${id}` — no body.

# Side Effects

- `GET /auth/side_effects` — same toggle-list shape as pain scores:
  `data[]`: `{id, name, sub_title, description, locked, activated}`.
- `POST /auth/side_effects/toggle` — `{question_id, state}`. Response `data[]`
  refreshed.
- `GET /auth/side_effect_stats_v2` — response `data`: keyed by side-effect
  type, `{id, name, time_ago, last_registration_score,
  last_registration_range_color_index}`. Clicking opens an overlay rather
  than navigating.
- `GET /auth/side_effect_stats_item/${id}` — response is `res.data` directly
  (no `.data.data`): `{title, sub_title, chart, data: [{id, completed_at,
  score, score_color_index}], information_tips: [{id, name, thumb_url}]}`.
- `POST /patient/side_effect_create` — `{date}` → `res.data.id` navigates to
  the fill-in screen.
- `GET /patient/side_effect/${id}` — response `data` → `side_effect`,
  `questions[]`, `data.patient_side_effect.questionnaire`.
- `POST /patient/side_effect/${id}/complete_side_effect` — `{questions,
  answers, additional_comments: [{id: question_id, value}]}` —
  `additional_comments` only for range-type questions where the user opted
  to add a comment.
- `POST /patient/side_effect_delete/${id}` — no body.

# Mental Health

- `GET /patient/mental_health/${id}` — response `data` → `mental_health`:
  `{vimeo_video_id, thumbs[], type, name, description, playlist_url,
  intended_date}`. Redirects to the list on error.
- `POST /patient/mental_health/${id}/complete_mental_health` —
  `{feedback: {finished: true, experience: <1-10 VAS>}}`. Routes to `tasks`
  with `date: intended_date`.

# Sleep Relaxations

- `GET /patient/sleep_relaxations/${id}` — response `data`: `{title, body,
  languages[], vimeo_video_id, thumb_url, is_favorite, id,
  sleep_relaxation_category_id}`.
- `POST /patient/sleep_relaxations/${id}/set_favorite` — `{state}`,
  optimistically applied client-side before the call resolves; on success
  emits a list-refresh event.

# Tiny Habits

- `GET /patient/patient_tiny_habits_stats/${date}` — scheduled items for the
  day: `data[]`: `{id, name, time_icon, intended_time, stats: {state,
  current_state: {state, count, achievement: {icon, text,
  is_new_achievement}}, history_shown[]}}`.
- `POST /patient/patient_tiny_habits_state/${id}` — `{date, state: 'yes'|
  'no'|'skip'}`. Response `data[]` — full refreshed array; shows an
  achievement overlay when `current_state.achievement.is_new_achievement`.
- `GET /patient/patient_tiny_habits_data?page=&search=&day=&load_additional_meta=`
  — paginated list (`urlContentLoaderMixin`), `day` defaults to
  `'all_days'`, `load_additional_meta` only true on first load. Response
  `data[]` + `meta` (`current_page`, `last_page`); on first load also
  `question_then_options`, `question_when_options`, `frequency_days_options`.
  Supports infinite scroll + 750ms-debounced search.
- `POST /patient/patient_tiny_habits` (create) / `PUT /patient/patient_tiny_habits/${id}`
  (update) — `{question_when, question_then, name, intended_time, start_date,
  end_date, frequency_days[]}`.
- `DELETE /patient/patient_tiny_habits/${id}` — confirm-gated.
- `POST /auth/change_tiny_habit_push_notification_state` — see Push
  Notifications above.

# Medications

- `POST /patient/patient_schedulable_medications_stats` — note: POST despite
  being a fetch (params in body): `{intended_date, intended_time}`. Response
  `data[]`: `{id, time_icon, intended_time, sub_title, name, body,
  external_link, external_link_text, explanatory_note, consumed: 0|1|null}`.
- `POST /patient/patient_schedulable_medications_state/${id}` —
  `{state: boolean, intended_time}` (`true` = consumed, `false` = skipped);
  client no-ops if already in that state. Response `data[]` refreshed.
- `POST /auth/change_medication_push_notification_state` — see Push
  Notifications above.

# Patient Photos & File Uploads

- `GET /patient/patient_photos` — response `data[]`: `{id, thumb, name,
  mime_type, tab}`; `nav_tabs[]`, `nav_tab_selected`. Refreshed on an
  upload-success event.
- `GET /patient/patient_photos/${id}` — response `data`: `{id, name, size,
  thumb, date, note}` (bound directly as the edit form model).
- `POST /patient/patient_photos/${id}` — round-trips the whole fetched
  object plus edits: `{date, note, id, name, size, thumb}`.
- `DELETE /patient/patient_photos/${id}` — confirm-gated.
- `POST /upload_photo` — chunked upload, `multipart/form-data` per chunk:
  `chunk` (Blob), `chunk_index`, `total_chunks`, `filename`, `file_size`,
  `type` (looks up `chunk_size`/`allowed_mimes`/`max_file_size` from
  `getUploadConfigurations[type]`, itself populated from the
  `/translations/application/${locale}` response), `upload_id` (echoed back
  after the first chunk returns one). Response per chunk: `upload_id`,
  `progress` (0–100), `status` (`'completed'` on the final chunk resolves
  the whole upload). Client validates file size/mime before starting.
- `POST /file_manager_media_data` — `{media: [id]}` → resolves a media id to
  a URL: response `data[0].original_url`. Used by a generic
  `PlaceholderImage` component, not upload-specific.

# Osasense

- `POST /patient/osasense_data_records` — `{items: [{date, hr, spo2, battp,
  ...}]}` — a batch of parsed Bluetooth LE device readings, flushed every
  10s from a local buffer (not one request per reading). No response
  consumed. All other Osasense logic (BLE scan/connect, live charts) is
  local Bluetooth, not HTTP — see `pages/Osasense/Index.vue`.

# Notes

- `GET /patient/notes` — response `data[]`: `{id, title, body, created_at}`.
  Note: `Show`/`Edit` pages re-fetch the *whole list* and find the target
  note client-side by id rather than fetching a single note.
- `POST /patient/notes/create` — `{title, body}`.
- `POST /patient/notes/update/${id}` — `{id, title, body}`.
- `DELETE /patient/notes/${id}` — confirm-gated.

---

# Questionnaires

- `GET /patient/questionnaire_module_index?page=1&type=<type>` — response
  `items[]`, `module_name`, `button_text`. (Page hard-coded to 1 in this
  view — no infinite scroll wired here despite the generic mixin pattern.)
- `POST /patient/questionnaire_module_index/new?type=<type>` — no body;
  response `patient_questionnaire_id` → navigates to the questionnaire
  taking flow with `?action=start&type=<type>`.
- `POST /patient/questionnaires/${id}/calc` — `{answers: {[questionId]: value}}`
  — the branching-logic engine, debounced 250ms with `CancelToken`
  cancellation of in-flight requests, called on mount and whenever an
  answered question is in `questionnaire.conditional_question_ids`.
  Response: `data.questionnaire` (replaces state), `consents[]` /
  `givenConsents[]` (gates the "end" of the flow), `current_question_index`,
  `draft_answers` (resume), `can_save_draft` (default `true`), `redirect`,
  `data.questions` (`.current` full list on first calc, or `.new`/
  `.removed_ids` incremental diff afterward).
- `POST /patient/questionnaires/${id}/save_draft` — `{data: answers,
  current_question_index}` — autosave, fired every 30s, on `beforeunload`,
  and on exit (if `can_save_draft`).
- `POST /patient/questionnaires/${id}/delete_draft` — no body; used instead
  of save_draft on exit when `can_save_draft` is false.
- `POST /patient/questionnaires/${id}/save` — `{answers}` — final submit,
  gated behind a confirmation overlay and behind resolving all "end"
  consents first. Response drives the post-completion route:
  `redirect === "archive"` → archive view; any other `redirect` string →
  that named route; `has_visible_tests` → lab-test selection; else falls
  back to the `type` query param or `tasks`.
- `POST /patient/questionnaires/${id}/save_consent` — `{patient_consent_id,
  accepted}` — consent decisions gating `/save`; a decline with
  `consent.redirect_decline` shows a "declined" screen instead of
  continuing; once all "end" consents resolve, auto-triggers the final save.

# Available Patient Questionnaires

- `GET /patient/available_patient_questionnaires/${id}/show?page=&search=`
  (via the generic paginated content-loader mixin) — response: standard
  paginated shape (`data.data[]`, `data.meta`) plus `name` (page title) and
  `show_action_button`. Items split client-side into "remaining" (no
  `completed_at`) vs. "completed".
- `POST /patient/available_patient_questionnaires/store` —
  `{available_patient_questionnaire_id}`. Response `patient_questionnaire_id`
  → navigates to the questionnaire (note: navigation happens in `.finally`,
  so it fires even on error with a possibly-empty id).
- `POST /patient/available_patient_questionnaires/delete` —
  `{patient_questionnaire_id}` — confirm-gated; reloads page 1 on success.

# Patient Registrations (Biometrics)

- `GET /patient/patient_registration_types` — response `data[]`:
  `{name, enabled, ...}`.
- `POST /patient/patient_registration_types` — `{items: [...same array with
  updated enabled flags]}` — whole array resent on every toggle.
- `GET /patient/patient_registration_stats` — response: `types[]`, `icons`
  (map type→SVG string), `data` (map type→ latest `{date, value}`),
  `types_fillable[]` (which support manual entry),
  `home_measurement_notifications[]` (`{type, matching_items, text}`
  threshold alerts).
- `GET /patient/patient_registration_stats/${type}?frequency=<tab>` —
  debounced 300ms, re-fires on type or frequency-tab change. Response
  assigned wholesale: `available_frequency_tabs[]`,
  `current_selected_frequency_tab`, `chart_data` (fed straight to
  `ExternalGraph` as a local prop — registration graphs do **not** call
  `app_graph_data`), `data` (date→value history; nested shapes for
  `blood_pressure_*` = `{systolic, diastolic}`, `cholesterol` =
  `{ldl, hdl, triglycerides, ratio, value}`, `glucose_value` =
  `{value, consumption_moment}`).
- `POST /patient/patient_registration/create` — `{type}`. Response
  `data.id` → opens the fill-in form for the new record.
- `GET /patient/patient_registration/${id}` — response `data`: `type,
  can_manage (editable date?), guideline/short_guideline/guideline_img_url,
  consumption_moment_options (glucose only), added_by_type, intended_date`.
- `POST /patient/patient_registration/${id}` — body varies by type: generic
  `value`; `blood_pressure_in_peace` → `systolic, diastolic`; `cholesterol`
  → `ldl, hdl, triglycerides` (client-computed `total_cholesterol`/`ratio`
  are display-only, **not** sent); `glucose_value` → `value,
  consumption_moment`; plus `import_id, type_measurement, created_at` when
  imported from HealthKit/Google Fit, and `date_value` (overlay variant
  only — the full-page variant's date is fixed to the task's intended
  date). Response `remaining_registrations` drives whether to continue the
  task flow (`tasks`) or go to stats.
- `DELETE /patient/patient_registration/${id}` — only offered when
  `added_by_type` includes `'Patient'` (not for clinician-entered values).

# Information Tips

- `GET /patient/information_tip/${id}` — a patient's *assigned* tip
  (task instance). Response `data` (`completed_at`, `intended_date`) +
  `data.information_tip` (`name, description, thumb_url, thumbs[],
  vimeo_video_id, video_type, type, playlist_url, languages[]`).
- `GET /patient/information_tip_item/${id}` — a standalone library tip (not
  tied to a task) — response `data` used directly, no assignment wrapper.
- `POST /patient/information_tip/${id}` — mark complete; no body. Only
  shown for `type === 'patient_information_tip'` when not already completed
  and `intended_date <= now` (can't complete future-dated tips).

# Module Lessons

- `GET /patient/module_lesson/${id}` — response `data`: `{name, description,
  title, thumb_url, vimeo_video_id, language, can_complete, complete_text,
  pivot_id, show_patient_questionnaire_overlay, patient_questionnaire_id,
  data: [{name, items: [{name, short_description, description, required,
  show_required, completed, can_complete, complete_text, sub_title,
  thumb_url, vimeo_video_id}]}]}`.
- `POST /patient/module_lesson/${pivot_id}/complete_selected_item` —
  `{item: <selectedItem>}` (uses the pivot id, not the lesson id; sends the
  whole sub-item object back). Response `data` replaces the lesson; if
  `item.completed_all_requirements`, emits a task-status update and closes.

# Graph Data

- `POST /patient/app_graph_data/${id}` — `{type: 'patient_questionnaire' |
  'questionnaire'}` — shared chart-data endpoint used only by
  questionnaire-related graphs (`PatientQuestionnaireOverlay.vue`); `id` is
  either a patient-questionnaire instance id or a questionnaire template id
  matching `type`. Response: object keyed by chart/metric name → an
  ApexCharts-style options object (optionally `min_width`, default 300px);
  first key auto-selected if any exist.

---

# Lab Tests

Multi-step order flow: `Index.vue` (dashboard: available tests / resumable
orders) → `Questionnaires.vue` (pick which completed questionnaire's
recommended tests to act on) → `LabtestSelection.vue` (pick tests, creates a
draft order) → `OrderForm.vue` (3-step wizard: personal info → address →
review/submit → payment) → external PSP checkout (e.g. Mollie) →
`Confirmation.vue` (status + details by order reference).

- `GET /patient/labtests/index-data` — response: `available_count`,
  `pending_orders[]` (`{id, status, created_at, total_amount, tests[]}`).
  `pending_payment` orders get a "resume payment" action
  (re-hits the payment endpoint below); others resume into the order form.
- `GET /patient/labtests/questionnaires-with-tests` — response
  `questionnaires[]`: `{id, questionnaire_name, completed_at, test_count,
  draft_order_id}` — presence of `draft_order_id` skips straight to the
  order form instead of test selection.
- `GET /patient/labtests/visible-tests?patient_questionnaire_id=` — response
  `tests[]` (`{id, name, description, image_url, price, price_with_vat}`),
  `vat_rate` (default 21). Subtotal/VAT/total computed client-side.
- `POST /patient/labtests/select-tests` — `{labtest_ids[], patient_questionnaire_id}`.
  Response `order_id`.
- `POST /patient/labtests/dismiss-labtests` — `{patient_questionnaire_id}` —
  "I don't need these tests" path, fire-and-forget.
- `GET /patient/labtests/order/${orderId}/form` — response: `genders[]`
  (default male/female/other), `countries[]` (default nl/be/de), `tests[]`,
  `default_country`, `order` (`patient_questionnaire_id, subtotal,
  vat_rate, vat_amount, total_amount`), `patient` (personal info +
  `addresses` keyed `shipping`/numeric, tolerant of `postal_code`/`postcode`
  and `house_number`/`number` naming variants, with a `verified`/`validated`
  flag).
- `POST /patient/address/lookup` — `{country, postal_code, house_number}` →
  `{verified, street, city}` — auto-fires on blur once both fields are
  filled.
- `POST /patient/address/validate` — `{country, postal_code, house_number,
  street, city, save_to_patient: true}` → `{valid, acceptable, address?}` —
  explicit "validate address" action; only success when both `valid` and
  `acceptable`.
- `POST /patient/labtests/order/${id}/cancel` — no body. Response
  `{patient_questionnaire_id}` → discards the draft and returns to test
  selection for that questionnaire.
- `POST /patient/labtests/order/${id}/submit` — body: full personal +
  validated-address form (`first_name, last_name, gender, date_of_birth,
  email, phone_number, country, postal_code, house_number,
  house_number_addition, street, city, address_verified`). Response
  `{success, next_step, order_id}` — `next_step === 'payment'` triggers the
  payment call; any other value with `success` means a no-payment-needed
  completion. `422` errors map back into the correct wizard step.
- `POST /patient/labtests/order/${orderId}/payment` — no body. Response
  `{order_reference, free_order, checkout_url}` — `free_order` skips
  straight to confirmation; otherwise opens `checkout_url` externally
  (browser tab or Capacitor external-link, depending on platform).
- `GET /patient/labtests/order/${reference}/status` — response `{order_id,
  status, paid_at}` — a one-shot check (not an actual poll loop, despite
  unused polling-state fields left in `OrderForm.vue`).
- `GET /patient/labtests/order/${orderId}/details` — response `{tests[],
  order: {subtotal, vat_rate, vat_amount, total_amount}}` — merged with the
  status response into the final confirmation screen.

---

# Preset Programs (Mocia / Corsano)

`patient_preset_programs` is a generic backend resource for structured,
multi-week coaching/lifestyle programs; **"Mocia" is the in-app brand name**
for this family of programs. Each module is resolved to a fixed preset
program id client-side (`store/Mocia.js` `initModuleContext`):

```js
{ balanced_bite: 1778, move_better: 1687, sleep_patterns: 1678,
  cognitive_training: 1777, relax_recharge: 1779 }
```

**Corsano** (a wearable brand) and **Osasense** are separate, unrelated
device-sync subsystems — `pages/Corsano/CorsanoConnect.vue` is a pure
Bluetooth LE pairing screen with no HTTP calls at all; biometric data they
collect is presumably surfaced through a program's own `today`/`period`
data (e.g. `sleep_patterns`), not through device-specific routes.

All endpoints below are `patient/patient_preset_programs/${presetProgramId}/...`
unless noted:

- `GET auth/patient_preset_programs/progresses` — response: object keyed by
  menu-item route → progress value (0–1), used to annotate the main menu.
  Refreshed after `store` (enroll) and `exit`.
- `GET .../show` — main "get program state" call, fired on every entry into
  a module page. Response: `moduleStarted`, `name` (locale map), `tasks[]`,
  `pause: {enabled, endsAt}`, `report` (has-report-today), `settings.notifications`.
- `POST .../store` — enroll/start. No body. Response: `moduleStarted,
  tasks[], settings.notifications`. Special error:
  `message === 'Too many modules started'` → shows a module-limit paywall
  overlay (server-enforced concurrent-program cap).
- `GET .../today` — module-specific "today" report (only `sleep_patterns`
  has a client-side service implementation): `heartRateDate, sleepTime,
  sleepScore, sleepScoreMapped, sleepQuality, sleepData, heartRates`.
- `GET .../period?period=<1|4>` — 1 = weekly, 4 = monthly. Response
  `periods[]`.
- `GET .../downloadable_periods` — list of periods available for
  PDF/report export.
- `GET .../download?period=<n>` — response `url` (single file, opened
  directly) or `files[]` (multiple, shown in a picker overlay).
- `GET .../goal` — response: arbitrary goal Q&A object (`questions`, `goal.text`).
- `GET .../goal_questionnaire?initial=false` — response: a task descriptor
  passed to the generic task-navigation helper.
- `GET .../goal_information_tip` — gate shown before first-time goal
  setting: response `status` (true ⇒ proceed straight to the goal
  questionnaire) or a full information-tip task payload to show first.
- `GET .../library` — program's content/education library, response is an array.
- `GET .../pause_info` — response `count` (pauses used), `settings:
  {maxPauses, pauseDurationDays}` — used to compute whether the user can
  still pause.
- `GET .../notification_settings/information_tip?category=<cat>` — per-category
  info gate before changing a notification toggle; response `status`
  (true ⇒ no-op) or an info-tip task payload.
- `POST .../exit` — stop/leave the program, no body; refreshes menu
  progress afterward.
- `POST .../notification_settings` — body: object keyed by notification
  category → boolean. The store commits the *sent payload itself* as new
  state (response not used for this).
- `POST .../pause` — no body. Response `pauseEndsAt, tasks[]`.
- `POST .../resume` — no body. Response is the tasks array **directly**
  (not wrapped in `.tasks`, unlike `/pause` — an inconsistency to watch for).

---

# Ekomenu Recipes

- `GET /patient/nutrient_ekomenu_recipes` (paginated content-loader) — query:
  `sort_by_selected, filter_search, filter_lifestyle_id,
  filter_preparation_time, filter_difficulty, filter_day_part, filter_tags,
  filter_allergens`. Response: `data[]` + facet metadata (`lifestyle_ids,
  difficulties, day_parts, preparations, allergens, tags, total_items`) —
  facets can change per result set.
- `GET /patient/nutrient_ekomenu_recipes/${id}` — response is `res.data`
  directly (no wrapper): `id, name, sub_title, thumb_url,
  ekomenu_order_url, duration, kcal, difficulty, intro, stats[]
  ({title, value}), ingredients` (keyed by person-count tabs, default
  preferring `tab-2`), `preparation: {title, sub_title, steps: [{step,
  description, checked}]}, values[] ({title, value}), allergens[],
  is_favorite`.
- `POST /patient/nutrient_ekomenu_recipes/${id}/set_favorite` — `{state}`;
  emits a list-refresh event rather than reading the response.
- `POST /patient/nutrient_ekomenu_recipes/${id}` — add to diary:
  `{day_part, product_item_amount: 0.25|0.5|0.75|1, intended_date,
  scheduled_id}`.
- `POST /patient/nutrient_ekomenu_recipes/${pivot_id}/edit` — edit a
  scheduled/diary entry: `{day_part, product_item_amount, intended_date}`
  (note: uses the diary pivot id, not the recipe id).
- `DELETE /patient/nutrient_ekomenu_recipes/${pivot_id}` — confirm-gated.

# Treatment Plans

- `GET /patient/treatment_plans` — response `data[]`: `{id,
  treatment_plan_id, start_date, end_date}`; auto-redirects to the single
  plan's detail view if exactly one is returned.
- `GET /patient/treatment_plans/${id}` — response `data`:
  `treatment_plan_id, treatment_plan_external_link, start_date, end_date,
  amount_of_weeks, settings: {strength_training_sessions, cardio_sessions,
  interval_sessions, activities}`.

# Articles

- `GET /patient/articles/${id}` — response `data`: `title, body` (HTML),
  `languages[0]` (used for text-to-speech), `vimeo_video_id, thumb_url, id,
  article_category_id`.

# Help Center & Translations

- `GET /translations/application/${locale}` — called both on app boot
  (`MainApp.vue`) and on manual language change. Response: `messages` (i18n
  strings), `used_lang` (confirmed active locale, becomes the
  `Use-Language` header going forward), and — boot call only —
  `languages[]`, `server_settings`, `app_images[]`, `upload_configurations`
  (per-upload-type config consumed by the chunked uploader), `news_articles[]`,
  `schedulable_models`. App render is gated on this call completing.
- `GET /help_center_items?id=<id>` — single help item: `title, sub_title,
  thumb_url, vimeo_video_id, body, action` (`action === 'forgot_password'`
  renders a link to the forgotten-password flow).
- `GET /help_center_items?locale=<locale>&category=<category>` — listing
  view: `data[]` (`id, title, sub_title`); selecting an item just re-issues
  the by-`id` request above rather than resolving client-side.

---

## Notable cross-cutting conventions

- **Toggle-list endpoints** (pain scores, side effects, GLI consents by id)
  consistently return the *entire refreshed collection*, not just the
  changed item.
- **"Create for today" endpoints** (`pain_score_create`, `side_effect_create`,
  activity/goal check-ins, medications/tiny-habits state) are all keyed by
  `date`/`intended_date` — the backend find-or-creates a per-day record
  rather than requiring the client to know an id up front.
- **Paginated list endpoints** (tiny habits data, ekomenu recipes, available
  patient questionnaires) share one client-side pattern
  (`urlContentLoaderMixin`): Laravel-style `meta.current_page`/`last_page`,
  query-string filters, infinite scroll on a scroll-bottom event, and
  debounced search (usually 300–750ms).
- Several endpoints have response-shape quirks worth double-checking if you
  build against them: `/pause` wraps tasks in `{tasks: [...]}` but `/resume`
  returns the tasks array bare; some "fetch" calls are `POST` with body
  params instead of `GET` with query params (`patient_schedulable_medications_stats`,
  `patient_custom_goals_stats` is a GET but medications-stats is a POST).
