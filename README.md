<p align="center"><img src="icons/icon128.png" width="96" alt="LIT padlock mark"></p>

<h1 align="center">LIT</h1>

<p align="center"><b>The accountability layer for the job hunt.</b><br>
Every application sent, every problem solved, counted automatically and painted onto your calendar.</p>

<p align="center"><i>Locked In Tracker · Chrome Extension · v1.3.0</i></p>

---

## The one-liner

**LIT is Strava for getting hired.** It watches the sites where the grind actually happens (LeetCode, NeetCode, Greenhouse, Lever, Ashby, Workday), logs your work the moment you do it, and shows the results on the calendar you already live in.

## The problem

Job hunting is a volume game, and volume is invisible.

- You apply to 12 roles on Tuesday and 0 on Wednesday, and by Friday you can't remember which was which.
- You solve 40 LeetCode problems and feel like you've done nothing, because nothing shows it.
- Spreadsheets die by week two. Habit apps want you to tap a button, and you forget to.

The people who get offers aren't more talented. They're more consistent. **Consistency is hard to keep up when you can't see it.**

## The solution

LIT makes the grind visible with **zero manual logging**.

| | |
| --- | --- |
| **It auto-tracks.** | Hit *Accepted* on LeetCode, pass a problem on NeetCode, or submit an application on Greenhouse, Lever, Ashby, or Workday, and LIT logs it. A toast confirms it. Nothing else to do. |
| **It lives on your calendar.** | Every day on Google Calendar gets a small pill: *"3 Job Applications"*, *"2 LeetCode"*. Filled means you hit your goal. You'll see the gaps. |
| **It keeps you honest.** | Daily goals, streaks, rolling week/month totals, activity charts, and a solve timer, all in a popup you can rearrange to fit how you work. |
| **It follows you.** | Everything syncs through your Chrome profile. Laptop, desktop, library computer: same numbers. |

## How it works

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │  leetcode.com   neetcode.io   greenhouse   lever   ashby   workday    │
  │       │              │            └────────┬─┴───────┴───────┘        │
  │   Accepted        Passed /            Application submitted           │
  │                   checkbox                                            │
  └───────┬──────────────┬─────────────────────┬──────────────────────────┘
          └──────────────┴──── adapters ───────┘
                                │
                     auto-tracker core: dedupe, toast
                                │
                        chrome.storage.sync   ◄────  popup (+1 / -1, widgets)
                                │
                  Google Calendar overlay: day badges, quick add
```

**Detect → Log → Show.** You don't open LIT to do your work. It sits next to the work you're already doing.

## Why now

- Hiring cycles are longer and more crowded than ever. Candidates routinely send **hundreds** of applications per offer.
- Technical interviews still come down to reps: pattern recognition built one problem at a time.
- Almost all of this happens in the browser, on a handful of platforms. That's what makes zero-effort tracking possible.

## The product

### The popup: your command center

A fixed counter card up top (big number, `+1`, `-1`) and below it a **fully customizable widget board**.

| Widget | What it does |
| --- | --- |
| **Daily Goal** | Progress bar toward today's target. Click the number to change it. |
| **Week / Month / Total** | Rolling counts at a glance. |
| **Activity Chart** | 7, 14, or 30 days of bars, with total, average, active days, and best day. |
| **Streak** | Current and longest run of goal-hitting days. Don't break the chain. |
| **Solve Timer** | Interview-style countdown for LeetCode. **Space** to start/pause. |
| **Solve Time Stats** | Today, all-time, average, fastest. See yourself getting faster. |
| **Add Details** | Tag the next entry with company, role, and notes. |

Hit **+** to add a widget. Drag to reorder. Pin two Activity Charts to two trackers and compare side by side. Your layout syncs everywhere.

### The calendar overlay: your scoreboard

LIT draws its badges in a layer of its own, never inside Google Calendar's cells, so your events and tasks stay exactly where they were. Works in Day, Week, and Month view, and adapts to narrow columns. Hover any day for a quick **+** to backfill.

### Autofill: fill applications in one click

Fill in your profile once (open LIT, **Settings > Autofill profile**). On Greenhouse, Lever, Ashby, Workday, and the other supported career sites, an **Autofill** button appears at the bottom right of any page with an application form. Click it, or press **Alt+Shift+F**. Filled fields get a green outline and fields that need you get an amber one.

On any other site, such as a company's own applicant system (TikTok, for example), press **Alt+Shift+F**, click **Autofill** in the LIT popup, or right-click and choose **Autofill this page**. With **Detect applications on any career site** turned on, the button shows up there by itself whenever the page has an application form.

The button and its cards stay out of the way. Drag the grip (or the button) anywhere, and LIT remembers the spot for each site. When the field you are editing is under the widget, the widget moves aside. Questions such as "save answer for next time?" appear beside the button, not over the form. The X hides the button on that page.

- **No AI and no servers.** Fields are matched by rules: site-specific selectors first, then rules you taught it, then the page's `autocomplete` hints, then a dictionary of common phrasings ("legal first name", "will you now or in the future require sponsorship").
- **It learns from everything you answer.** Text boxes, dropdowns (including custom ones like Workday's and Greenhouse's), multiple choice, checkboxes, and yes/no buttons. Fill or change one and LIT either learns it outright (when it matches your profile) or offers to remember it for that site or all sites. Fields that appear on later steps count too. Long answers can go into an answer bank and get suggested the next time a similar question shows up.
- **You stay in control.** Autofill never clicks Submit. EEO questions are left blank unless you turn them on. LIT never learns from password, card, or SSN fields.
- **Your data stays on this device**, in `chrome.storage.local`. Export and import it as JSON from the profile page.

### Privacy and accounts

Logs are scoped to the signed-in account, so two Google accounts never see each other's data. No backend and no third-party servers: your data lives in your own Chrome sync storage.

## Get started in 60 seconds

No build step. No sign-up funnel.

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. Pin LIT. Open Google Calendar, LeetCode, or any supported job board and get to work.

> Google sign-in requires an OAuth client ID in `manifest.json`. Without one, the popup offers direct email sign-in so accounts still stay separate.

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

### Calendar overlay

`content/content.js` finds day cells and reconciles badges into them, re-rendering only what changed. Dates come from Calendar's own `data-datekey` attribute:

```
dateKey = (year - 1970) * 512 + (month - 1) * 32 + day + 32
```

with fallbacks for the other formats Calendar uses across views.

### Storage built to survive `chrome.storage.sync`

`shared/storage.js` wraps `chrome.storage.sync` with a **write queue and read-back verification**. The popup and content scripts each hold their own copy of the module against one shared store, and `chrome.storage` has no compare-and-swap.

Sync caps out at 100KB total and 8KB per item, so:

- **Chunked logs.** The log array is split into size-bounded chunks (`logs__meta`, `logs__c0`, `logs__c1`, ...).
- **Graceful overflow.** If a very long history fills the budget, new entries fall back to `chrome.storage.local['logs_overflow']` instead of being lost. The overflow clears itself once history shrinks back under quota.
- **Seamless migration.** Older local-only installs move their history into sync automatically on first run after updating.

Logs, trackers, theme, widget layout (`pt_widgets`), and the signed-in account all live in sync storage.

### Tested

A suite covering storage, concurrency, account isolation, auto-tracking, autofill, the calendar overlay, widgets, timers, and metrics, plus adversarial storage and stress tests in `tests/`.

```
node test/run_all.js
```

---

<p align="center"><b>Stop wondering if you're doing enough. Start seeing it.</b><br>
<i>Get LIT. Stay locked in.</i></p>
