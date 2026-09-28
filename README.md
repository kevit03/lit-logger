<p align="center"><img src="icons/icon128.png" width="96" alt="LIT padlock mark"></p>

# LIT (Locked In Tracker)

A Chrome extension that counts applications sent and problems solved, shows every day's numbers on your calendar, and logs most of it for you automatically. 

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

There is no build step.

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the folder.
3. Pin the extension. Open Google Calendar, LeetCode, or any supported job board and go.

Google sign-in needs an OAuth client in `manifest.json`; without one, the popup offers a direct email sign-in so you can still keep accounts separate.

## The popup

The counter card at the top is fixed: big number, `+1`, `-1`. Everything under it is a **widget layout** you control.

| Widget | What it shows |
| --- | --- |
| Daily Goal | Progress bar toward the tracker's goal; select the number to change it |
| Week / Month / Total | Rolling counts |
| Activity Chart | 7, 14, or 30 days of bars with total, average, active days, best day |
| Streak | Current and longest run of days the daily goal was met |
| Solve Timer | Countdown for a problem (LeetCode tracker only) |
| Solve Time Stats | Today, all time, average, fastest |
| Add Details | Company, role, and notes for the next entry |

The centered **+** adds a widget. Hover one and a grip and a gear appear: drag the grip to reorder, or open the gear to pin the widget to a tracker or let it follow the selected tab, set chart length, nudge its position, or remove it. Pin two Activity Charts to two trackers and compare. The layout persists in `chrome.storage.sync['pt_widgets']`, so it carries over to any other device signed into the same Chrome profile.

On the LeetCode tab, **Space** starts and pauses the timer when nothing else has focus.

## How it works

### Calendar overlay

`content/content.js` finds day cells on Google Calendar and reconciles badges into them, re-rendering only what changed. Badges are drawn in a layer of the extension's own, never inside Calendar's cells, so Calendar's layout and its event and task chips are untouched. Each day gets a small right-aligned row of pills, one per tracker with entries that day, labelled with the tracker's name ("1 Job Application", "2 LeetCode"); where a column is too narrow for the words, the pills show the count alone and keep the words in their tooltip. They sit beside the date number in Week and Day view and on the date line in Month view; a filled pill means the daily goal was met. Hovering a day shows a **+** for a quick entry. Dates come from Calendar's own `data-datekey` attribute, decoded with

```
dateKey = (year - 1970) * 512 + (month - 1) * 32 + day + 32
```

with fallbacks for the other formats Calendar uses across views.

### Auto-tracking

One declarative adapter per site in `content/adapters/`, registered with `shared/auto-tracker-core.js`:

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

### Storage

`shared/storage.js` wraps `chrome.storage.sync` with a write queue and read-back verification, because the popup and the content script each hold their own copy of the module against one shared store and `chrome.storage` has no compare-and-swap. Logs carry the signed-in account so two Google accounts never see each other's data.

Everything (logs, trackers, theme, widget layout, and the signed-in account) lives in `chrome.storage.sync`, so it follows you to any other device signed into the same Chrome profile, not just the machine you logged it on. `chrome.storage.sync` caps out at 100KB total and 8KB per item, so the logs array — the one value that can realistically grow past that — is split into size-bounded chunks (`logs__meta`, `logs__c0`, `logs__c1`, ...) instead of one big item. If a very long history ever fills the 100KB budget, new entries fall back to `chrome.storage.local['logs_overflow']` on that device rather than being lost; older history keeps syncing everywhere, and the overflow clears itself automatically once the history shrinks back under quota (e.g. after deleting old entries). An existing local-only install migrates its history into sync automatically the first time it runs after updating.
