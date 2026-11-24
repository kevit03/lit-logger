# LIT

A Chrome extension that tracks your job search.

Submit an application and LIT logs it, then shows your daily count on Google Calendar. It can also fill out application forms for you. Basically, no more spreadsheet.

## Run it

Plain JS, no build step.

```sh
git clone https://github.com/kevit03/tracker.git
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the folder. After you change code, hit reload there and refresh any open job tabs.

## Test it

```sh
node test/run_all.js
```

No dependencies. Chrome and the DOM are mocked.

## Where things are

```
popup/         the popup
background/    service worker, auto-apply queue
content/       scripts that run on job sites, Calendar, LeetCode, Jobright
shared/        storage, autofill engine, auth
options/       autofill profile and settings
applications/  list of everything you applied to
```

To support a new job site, add an adapter in `content/adapters/` and register it in `manifest.json`. Copy `content/adapters/ats/lever.js`, it's 30 lines.

## Good to know

- Your data stays in your browser. There's no backend. Details in [PRIVACY.md](PRIVACY.md).
- Auto-apply submits real applications. Turn off **Submit automatically** in the Jobright panel if you want to check them first.
- It won't make up answers. If a required question isn't in your profile or saved answers, it stops and leaves the tab open.
- Claude can write answers to open questions if you add your own API key. Off by default.
- Google sign-in is off until you add an OAuth client: [docs/google-sign-in.md](docs/google-sign-in.md).
