# Portable Ops Tools (Tampermonkey userscripts)

| Script | Install link (auto-updates) |
| --- | --- |
| Outbound Labor Pilot | https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js |
| Engage Coaching Tracker | https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/engage-coaching-tracker.user.js |

Install steps and the auto-update / publishing flow below apply to both scripts.
The version-bump workflow bumps only the script(s) changed in a push.

## Engage Coaching Tracker

Runs on the QuickSight Elevate dashboard. It scrapes the coaching list, shows
only associates currently on site (via Find People), and syncs completions and
"in progress" claims across leaders through Firebase.

- **Before installing:** if you already have an older copy (e.g. v41.45) in
  Tampermonkey, delete it first, then install from the link above. Old copies
  have no update URL and will never update themselves.
- Open Find People once so your site ID is captured (UNJ2 is built in).
- Keep one QuickSight coaching tab open so the list stays fresh for everyone.

# Outbound Labor Pilot (Tampermonkey userscript)

A Tampermonkey userscript for Helm / Outbound labor planning. It intercepts the
`HoudiniPickCapacity` API and renders a panel with Daily Totals, Pick Ahead By
Zone, and an Outbound Labor Plan.

## Install (2 minutes, one time)

Once you install from the link below, the script **updates itself
automatically** — you never reinstall.

**Step 1 — Get Tampermonkey (skip if you have it).** Install the
[Tampermonkey](https://www.tampermonkey.net/) browser extension from your
browser's extension store (Chrome Web Store / Edge Add-ons / Firefox Add-ons).

**Step 2 — Install the script.** Click this link (or paste it into your address
bar):

**https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js**

Tampermonkey opens an install screen. Confirm it says **Outbound Labor Pilot**
at the top, then click the green **Install** button.

> If the page just shows a wall of code instead of an install screen,
> Tampermonkey isn't installed yet — go back to Step 1.

**Step 3 — Use it.** Open Helm and go to a pick-capacity page. The panel appears
top-right. Drag it, minimize it, or switch tabs (Daily Totals / Pick Ahead By
Zone / Outbound Labor Plan). Click the gear icon to set site rates and CPTs.

### Trouble?

- **Link won't load / "can't reach site":** your network may block GitHub raw.
  Contact the maintainer — it can be hosted internally instead.
- **Panel doesn't show:** confirm you're on a Helm pick-capacity page and the
  script is toggled **on** in the Tampermonkey dashboard.

That's it. Updates arrive automatically (see below).

## How auto-update works

The script header contains:

```
// @updateURL    https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js
// @downloadURL  https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js
```

Tampermonkey periodically checks `@updateURL`, compares the hosted `@version`
against the installed one, and if the hosted version is higher it downloads the
new file from `@downloadURL`. No action needed from users.

- Default check interval is set in Tampermonkey (Dashboard → Settings →
  "Check for updates"). Users can also force a check via Tampermonkey Dashboard →
  the script row → "Check for userscript updates".

## Publishing an update (maintainer)

You do **not** edit the version by hand. Just make your changes and push:

```bash
git add outbound-labor-pilot.user.js
git commit -m "your change description"
git push
```

On push, the GitHub Actions workflow (`.github/workflows/bump-version.yml`)
automatically:

1. Reads the current `@version`
2. Increments the patch number (e.g. `1.7` → `1.8`)
3. Commits the bump back to `main` with `[skip ci]`

Because the hosted version is now higher than everyone's installed copy,
Tampermonkey pulls the update on its next check.

### Bumping minor / major versions

The workflow only bumps the last number. To jump a minor/major version
(e.g. `1.9` → `2.0`), edit the `@version` line yourself in the same commit —
the workflow will then continue bumping the patch from there.

## Network note

Auto-update requires that browsers can reach `raw.githubusercontent.com`. If
your network blocks public GitHub, auto-update will not fire and the script
would need to be hosted somewhere reachable instead.
