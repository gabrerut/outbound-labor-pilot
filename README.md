# Outbound Labor Pilot (Tampermonkey userscript)

A Tampermonkey userscript for Helm / Outbound labor planning. It intercepts the
`HoudiniPickCapacity` API and renders a panel with Daily Totals, Pick Ahead By
Zone, and an Outbound Labor Plan.

## Install (one time)

You need the [Tampermonkey](https://www.tampermonkey.net/) browser extension.

Click the raw link below — Tampermonkey will detect the `.user.js` file and
prompt you to install:

**https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js**

That's it. After installing once, you never have to reinstall — updates arrive
automatically (see below).

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
