<p align="center"><img src="icons/icon128.png" width="96" alt="LIT padlock mark"></p>

<h1 align="center">LIT</h1>

<p align="center"><b>A friendly daily tracker for your job search.</b><br>
Every application you send, counted for you and painted onto your calendar.</p>

<p align="center"><i>LIT: Job Search Tracker · Chrome Extension · v1.6.0</i></p>

---

## The one-liner

**LIT is Strava for getting hired.** It notices when you submit an application on Greenhouse, Lever, Ashby, Workday, and more than 20 other job sites, counts it, and shows your progress on the Google Calendar you already use. Networking chats, cold emails, interview prep, portfolio work, and LeetCode can be tracked too, if you want them.

## The problem

Job hunting is a volume game, and it is hard on the nerves.

You apply to 12 roles on Tuesday and none on Wednesday, and by Friday you can't remember which was which. Spreadsheets die by week two. Habit apps want you to tap a button, and you forget. Most days it feels like you've done nothing, even when you've done plenty.

## The solution

LIT does the counting so you don't have to, and it is kind about it.

| | |
| --- | --- |
| **Counts for you.** Submit an application on a supported job site and LIT logs it, with a small toast to confirm. Nothing else to do. |
| **A scoreboard you already look at.** Each day on Google Calendar gets a small pill, like *"3 applications"*. Filled means you hit your goal. |
| **A goal you can actually keep.** A daily goal (5 applications is a good start), streaks that respect rest days, and a padlock in your toolbar that locks shut when today's goal is met. |
| **Fills the boring parts.** Save your details once and LIT fills them into application forms. Nothing is submitted without you. |
| **Encouraging, never shaming.** Milestones, weekly stories, and a coach voice you pick. LIT never leads with a "0" or a "failed". |

## Get started in 60 seconds

No build step and no sign-up.

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. A welcome page opens. Answer four quick questions (or skip them all), then pin LIT from the puzzle-piece menu.

## The product

### Welcome (onboarding)

On a fresh install LIT opens `onboarding/onboarding.html` in a tab. Every step can be skipped, and everything can be changed later.

1. **What are you working on?** Pick focus areas: job applications (always on), networking chats, cold emails, interview prep, portfolio pieces, LeetCode. LIT creates a tracker for each pick and hides the ones you don't choose. Nothing is ever deleted.
2. **Your daily goal.** How many applications a day feels doable (5 by default), an optional "I'm going for..." line, and optional rest days.
3. **Apply faster.** A plain explanation of Autofill and a button to fill your profile. Optionally, **Count applications on any career site**: LIT explains exactly what it looks at and what it never does *before* Chrome shows its permission prompt.
4. **Daily check-in.** Opt in, pick a time and a coach voice (Gentle, Coach, or Drill), and see a preview of the notification.

The finish screen locks the padlock and points you to the toolbar icon and your Google Calendar scoreboard. Updating from an older version never shows onboarding.

### The popup

A fixed counter card up top (big number, `+1`, `-1`, a progress ring, and the padlock) and below it a **customizable widget board**.

| Widget | What it does |
| --- | --- |
| **Daily Goal** | Progress toward today's target. Click the number to change it. |
| **Week / Month / Total** | Rolling counts at a glance. |
| **Activity Chart** | 7, 14, or 30 days of bars, with total, average, active days, and best day. |
| **Streak** | Current and longest run of goal days, with rest days and freezes. |
| **Solve Timer** | Interview-style countdown for LeetCode practice. **Space** to start or pause. |
| **Solve Time Stats** | Today, all-time, average, fastest. |
| **Add Details** | Tag the next entry with company, role, and notes. |

Hit **+** to add a widget and drag to reorder. Your layout syncs everywhere.

### Streaks, rest days, and freezes

- **Rest days** (picked in onboarding or Settings) neither break nor extend a streak. Logging on a rest day still counts as a bonus.
- **Freezes**: every 7 goal days in a row earns a freeze (up to 2). A missed day that isn't a rest day spends one automatically, so one bad day doesn't erase weeks of work.
- **Milestones** at 1, 10, 25, 50, 100, 250, 500, and 1000, plus your first interview, each celebrated once.

### Daily check-in

Off by default. Turn it on in onboarding, in Settings, or from the check-in page. Once a day at your chosen time, LIT shows a **Chrome notification** in your coach voice, with **Log what I did** and **Open my check-in** buttons. It never opens a tab or steals focus on its own, and it stays quiet on rest days.

The check-in page shows today's tally and an encouraging line, this week as seven dots, and one button that logs +1 (with Undo). A two-minute pep-talk video waits under **Need a push?**. It is collapsed and never autoplays. Change the time or voice, or turn the check-in off, from the same page.

People updating from a version where the check-in was on by default keep it on.

### Toolbar padlock

The LIT icon is drawn live: an **open** padlock until today's applications goal is met, then **locked** in your accent color. It updates on every log, at startup, and at midnight. If drawing fails, the regular icon is used.

### Share cards

Share a milestone or your week as a 1200x627 image (three styles, light or dark) to paste into LinkedIn or a group chat. Cards show only numbers, your streak, and the week. **Company names are never included**, and "Keep share cards private" also leaves out your "Going for" line.

### Comfort mode and accent colors

**Settings > Look and feel** has six accent colors (coral, sage, ocean, plum, amber, slate), light and dark themes, and **Comfort mode**: bigger text and larger tap targets. Animations follow your system's reduced-motion setting.

### The calendar overlay: your scoreboard

LIT draws its badges in a layer of its own, never inside Google Calendar's cells, so your events and tasks stay exactly where they were. Works in Day, Week, and Month view, and adapts to narrow columns. Hover any day for a quick **+** to backfill.

### Autofill: fill applications in one click

Fill in your profile once (open LIT, **Settings > Autofill profile**). On Greenhouse, Lever, Ashby, Workday, and the other supported career sites, an **Autofill** button appears at the bottom right of any page with an application form. Click it, or press **Alt+Shift+F**. Filled fields get a green outline and fields that need you get an amber one.

On any other site, such as a company's own applicant system (TikTok, for example), press **Alt+Shift+F**, click **Autofill** in the LIT popup, or right-click and choose **Autofill this page**. With **Detect applications on any career site** turned on, the button shows up there by itself whenever the page has an application form.

The button and its cards stay out of the way. Drag the grip (or the button) anywhere, and LIT remembers the spot for each site. When the field you are editing is under the widget, the widget moves aside. Questions such as "save answer for next time?" appear beside the button, not over the form. The X hides the button on that page.

- **No AI and no servers.** Fields are matched by rules: site-specific selectors first, then rules you taught it, then the page's `autocomplete` hints, then a dictionary of common phrasings ("legal first name", "will you now or in the future require sponsorship").
- **It learns from everything you answer.** Text boxes, dropdowns (including custom ones like Workday's and Greenhouse's), multiple choice, checkboxes, and yes/no buttons. Fill or change one and LIT either learns it outright (when it matches your profile) or offers to remember it for that site or all sites. Fields that appear on later steps count too. Long answers can go into an answer bank and get suggested the next time a similar question shows up.
- **You stay in control.** The Autofill button never clicks Submit (only Auto-apply does, below). EEO questions are left blank unless you turn them on. LIT never learns from password, card, or SSN fields.
- **Your data stays on this device**, in `chrome.storage.local`. Export and import it as JSON from the profile page.

### Auto-apply: apply to Jobright jobs in parallel

On Jobright (`jobright.ai/jobs/...`), an **Auto-apply** button sits at the bottom left. It lists your recommended jobs, with Greenhouse, Ashby, and Lever postings checked by default. Pick how many run at once (5 to 10) and press **Apply**. LIT opens each application in a background window, fills it with your Autofill profile, checks every required field, clicks Submit, waits for the confirmation, closes the tab, and starts the next job. The panel shows each job's progress live.

LIT never guesses. A job becomes **Needs you** and its tab stays open, with the missing fields outlined, when a required question has no saved answer, a CAPTCHA appears, the form shows an error, the site wants a sign-in (Workday, iCIMS, Taleo), or nothing confirms the submission. Answer it there and LIT learns the answer for next time, so each batch needs you less. Turn off **Submit automatically** to fill only and submit yourself. Submit is clicked at most once per job, even if the page reloads. Jobs already submitted show **Applied** and start unchecked.

The **Refresh** button (circular arrow, top right of the panel) rebuilds the list from the jobs the Jobright page loaded, asks Jobright's Applied list and your tracker log again, and drops anything you have since applied to. It then checks every job card on the page against the list and says so in one line, or warns you to reload the Jobright page when a card is missing from the list. The **X** on a row removes a job you do not want; it stays removed across refreshes and visits until you press **Restore**. Queued jobs in a running batch have an X too, so they never open.

### Privacy and accounts

No backend and no third-party servers. Your entries live in this browser (IndexedDB), and your trackers and settings sync through your Chrome profile.

Entries are kept separately per account, so two people sharing a computer never see each other's data. There are two kinds of account:

- **Google sign-in**, once the owner of this build sets it up (below). Real Google OAuth: you pick an account in Google's own window.
- **A profile on this computer.** Without Google sign-in set up, LIT offers a local profile: type a name (or an email) and LIT keeps that profile's entries separate. It is not a Google sign-in, has no password, and sends nothing anywhere.

### Turning on Google sign-in (for the owner of this build)

`shared/auth.js` supports two OAuth setups. Pick one. Until one is configured, sign-in offers only the local profile, and no Google window is ever opened.

First, give the extension a stable ID. Unpacked extensions get an ID from their folder path, and OAuth clients are tied to an ID.

1. Load the extension once, open `chrome://extensions`, and note the ID. To keep it stable across machines, pack the extension once (**Pack extension**), take the public key from the `.pem` (or from the Chrome Web Store dashboard after uploading), and add it to `manifest.json` as `"key": "<base64 public key>"`.

**Option A: Chrome's built-in sign-in (recommended for Chrome).** Uses the Google account Chrome is signed into, with no extra window.

2. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project. Under **APIs & Services > OAuth consent screen**, set it up (External, app name "LIT", your support email) and add the scopes `openid`, `email`, `profile`. While the app is in Testing, add yourself as a test user.
3. Under **APIs & Services > Credentials**, choose **Create credentials > OAuth client ID**, application type **Chrome Extension**, and paste the extension ID as the Item ID.
4. Add this block to `manifest.json` with the client ID you were given:

   ```json
   "oauth2": {
     "client_id": "1234567890-abc123.apps.googleusercontent.com",
     "scopes": ["openid", "email", "profile"]
   }
   ```

5. Reload the extension. The popup's sign-in now opens Google's account chooser.

**Option B: Google's web sign-in window.** Works in Chrome, Edge, and Brave, with any Google account.

2. Same consent screen as above.
3. Create an OAuth client ID of type **Web application** and add the authorized redirect URI `https://<extension-id>.chromiumapp.org/`.
4. Put the client ID in `WEB_CLIENT_ID` at the top of `shared/auth.js` (no manifest change needed).
5. Reload the extension.

Do not add an `oauth2` block with a placeholder ID. Chrome's sign-in fails harder with a fake client than with none, and the manifest test rejects one.

---

## Under the hood

*For the engineers in the room.*

### Adapters: one file per site

Each supported platform is a small declarative adapter in `content/adapters/`, registered with `shared/auto-tracker-core.js`. Adding a new site is one file:

```js
core.registerAdapter({
  id: 'leetcode',
  metricId: 'leetcode',
  matches: url => url.hostname.endsWith('leetcode.com') && /^\/problems\//.test(url.pathname),
  routeKey: url => slugFrom(url),          // remount only when the problem changes
  init(onSuccess, ctx) {                   // arm detection, return teardown
    /* ... */
  }
});
```

The core handles deduping, toasts, and teardown, so a double-fired submit never double-counts.

### Autofill engine

`shared/autofill-core.js` scans the form, reads each field's label (`label[for]`, wrapping label, `aria-labelledby`, `aria-label`, nearby question text, placeholder, name), and matches it against the profile. Matching tries site adapter fields, then learned rules (this site before global), then `autocomplete`, then the synonym dictionary, then the answer bank. Values are set through the native value setter so React-controlled inputs notice.

Site adapters in `content/autofill/sites/` cover what the generic engine can't: react-select menus on Greenhouse, yes/no button pairs on Ashby, and Workday's listbox and multiselect widgets, which re-render after every edit. `shared/autofill-store.js` keeps the profile, resume, rules, and answers under `af_` keys, and `content/autofill/autofill-ui.js` draws the button inside a closed shadow root.

### Auto-apply

Three parts talk through `chrome.runtime` messages and one `lit_batch` record in `chrome.storage.local`. `content/jobright/jobright-panel.js` reads Jobright's own job list API and starts a batch. `background/batch-runner.js` keeps the queue: it runs N tabs at a time, enforces timeouts (45 s to find a form, 4 minutes overall), and survives the service worker being stopped, because every event re-reads the stored state. `content/autofill/auto-apply.js` runs in each batch tab: it fills the form with the Autofill engine, checks the required fields, submits once, and reports the result.

### Calendar overlay

`content/content.js` finds day cells and reconciles badges into them, re-rendering only what changed. Dates come from Calendar's own `data-datekey` attribute:

```
dateKey = (year - 1970) * 512 + (month - 1) * 32 + day + 32
```

with fallbacks for the other formats Calendar uses across views.

### Storage

`shared/storage.js` keeps entries in IndexedDB (`shared/db.js`) in the popup and the service worker, one record per entry, with per-day totals kept alongside for badges, streaks, and charts. Content scripts cannot reach the extension's IndexedDB, so they send log calls to the service worker. Trackers, theme, preferences, widget layout (`pt_widgets`), and the signed-in account live in `chrome.storage.sync`, behind a write queue with read-back verification.

### Service worker

`background/service-worker.js` hosts storage for content scripts, mirrors the solve timer into `chrome.alarms`, runs keyboard shortcuts and context menus, injects Autofill and the universal tracker on demand, books the daily check-in (`pt-reminder`) and the midnight icon refresh (`pt-midnight`), draws the toolbar padlock with `OffscreenCanvas`, opens onboarding on install, and migrates existing installs on update.

### Coach copy

Every encouraging line (headlines, toasts, milestones, check-ins, weekly stories) comes from `shared/coach-copy.js` (`LitCopy`), in three voices. Every surface falls back to plain text if it is missing.

### Tested

A suite covering storage, concurrency, account isolation, auto-tracking, autofill, the calendar overlay, widgets, timers, and metrics, plus adversarial storage and stress tests in `tests/`.

```
node test/run_all.js
```

---

<p align="center"><b>Stop wondering if you're doing enough. Start seeing it.</b><br>
<i>Get LIT. Stay locked in.</i></p>
