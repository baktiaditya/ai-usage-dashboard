---
type: Backlog Brief
title: Install the dashboard as a PWA
---

# Install the dashboard as a PWA

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The phone's Chrome offers to install the dashboard served at
`https://<machine>.<tailnet>.ts.net:8443/`, and installing it puts an "AI Usage Dashboard" icon
on the home screen that opens the dashboard full-screen (`display: standalone`) with the app's
own icon, name, and colors. Refresh keeps working inside the installed window. Nothing about
the loopback bind, the same-origin guard, or the tailnet exposure changes.

## Context

The [Tailscale brief](access-dashboard-over-tailscale.md) made the dashboard reachable and
refreshable from the phone, but it is still a browser tab. Chromium installability needs only
HTTPS (or loopback) plus a manifest carrying `name` or `short_name`, 192 px and 512 px icons,
`start_url`, a `display` of `standalone`, `fullscreen`, `minimal-ui`, or
`window-controls-overlay`, and `prefer_related_applications` absent or `false`; a service
worker is not required, only conventional for offline support
([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)).

Three facts about this repository shape the work:

- Next.js 16 serves a web app manifest from `src/app/manifest.ts` as `/manifest.webmanifest`
  and links it from every page's `<head>` through its metadata resolver. `src/app/icon.svg` is
  already a metadata file, but a manifest needs raster icons: Chrome parses an SVG-only icon
  list as 0×0.
- Both contexts the dashboard is served from are installable: the phone's tailnet origin is
  HTTPS, and the e2e server's `http://127.0.0.1:3939` counts as loopback.
- The layout already exports `viewport`, so the browser-UI color joins it in one line.

No new dependency is added (decided 2026-10-10, [log](../../log.md#2026-10-10)). Serwist is the
maintained Next.js PWA library and is what the Next 16 docs point at for offline support, but
the dashboard shows live data: a precached shell would present stale quota as current, and
Serwist hooks the build (a webpack or Turbopack adapter) for a feature the install flow does
not need. If offline behaviour is ever wanted, it belongs in its own brief.

## Dependencies and Gates

Every gate is closed:

- Installability needs HTTPS or loopback. The phone reaches the dashboard over tailnet HTTPS
  ([Setup](../../operations/setup.md) §6) and the e2e server uses loopback, so both paths
  qualify.
- The PNG icons are generated once from `src/app/icon.svg`; ImageMagick `convert` is present at
  `/usr/bin/convert` on the development machine, and the committed PNGs mean no machine needs a
  rasterizer at build or test time.
- No configuration, credential, or tailnet change is needed — the manifest is
  origin-independent, and `tailscale serve` already terminates TLS.
- The code, test, and documentation changes are inside the agent's executable scope.

Human-only, not needed to implement or merge, but needed to close the live check: install from
the phone's Chrome and confirm the standalone launch. An agent cannot operate the phone, so
report which live checks were actually performed.

## Scope

### In scope

- `src/app/manifest.ts` with the installability members and the two raster icons.
- `public/icon-192.png` and `public/icon-512.png`, rasterized once from `src/app/icon.svg`.
- `viewport.themeColor` for light and dark in `src/app/layout.tsx`.
- `tests/e2e/pwa.spec.ts`: the page links a 200 manifest with the required members, and both
  icons decode at their declared sizes.
- A short "Install it as an app" paragraph in Setup §6 under the phone subsection, and the
  `docs/log.md` decision entry.

### Out of scope

- Any service worker, offline caching, or a custom install button (`beforeinstallprompt`).
  Next's guide recommends against the custom button, and the browser's own affordance is
  enough.
- Push notifications.
- The Google Play Store and any TWA (Bubblewrap) wrapper.
- A maskable-icon variant for Android's adaptive treatment; the two declared icons install and
  render, and a maskable PNG is a separate polish decision.
- Per-origin manifests, and any change to the bind address, the origin guard, or
  `tailscale serve`.

## Approach

1. `src/app/manifest.ts`: `export default function manifest(): MetadataRoute.Manifest` with
   - `name: 'AI Usage Dashboard'` and `short_name: 'AI Usage'` (the label under a home-screen
     icon truncates);
   - `description` matching the layout's metadata description;
   - `start_url: '/'`, `display: 'standalone'`;
   - `background_color: '#f7f7f8'` (the light `--background`) and `theme_color: '#4338ca'`
     (the `--accent` the icon already uses);
   - `icons`: `/icon-192.png` as `192x192` and `/icon-512.png` as `512x512`, both
     `type: 'image/png'`.
2. Create the repo's first `public/` directory and rasterize `src/app/icon.svg` (a 32-unit flat
   SVG: rounded indigo square, three bars) once, for example
   `convert -background none -density 1536 src/app/icon.svg public/icon-512.png` and
   `-density 576` for the 192 px variant, then check both with `identify`. Any equivalent
   rasterization is acceptable; the assertion is the decoded pixel size, and the PNGs are
   committed so nothing at build or test time depends on the tool.
3. `src/app/layout.tsx`: extend the existing `viewport` export with `themeColor` entries for
   `(prefers-color-scheme: light)` `#f7f7f8` and `(prefers-color-scheme: dark)` `#09090b`, the
   two `--background` values. The manifest keeps single values because the format has no
   scheme variant; the viewport entries color the browser UI per scheme.
4. `tests/e2e/pwa.spec.ts`, in the style of `dashboard.spec.ts`:
   - assert `link[rel="manifest"]` exists, fetch its `href`, and assert `200` plus the required
     JSON members (`name`/`short_name`, `start_url` `/`, `display` `standalone`, icons covering
     192 and 512 PNGs);
   - fetch each icon URL, decode it in the page with `createImageBitmap`, and assert the exact
     dimensions and an `image/png` content type. Both Playwright projects (desktop and Pixel 7)
     run the spec automatically.
5. Documentation:
   - Setup §6, after the `tailscale serve` steps: open the tailnet URL in the phone's Chrome,
     use the browser's **Install app** (or **Add to Home screen**), and launch it from the icon;
     note that the installed app needs Tailscale connected, and that the manifest lives in
     `src/app/manifest.ts`.
   - `docs/log.md`: a `Decision` entry under 2026-10-10 naming the manifest-only, no-dependency
     choice and the Serwist deferral, and recording the brief.

## Files Touched

| Path                       | Change                                                    |
| -------------------------- | --------------------------------------------------------- |
| `src/app/manifest.ts`      | New: manifest route with installability members and icons |
| `public/icon-192.png`      | New: 192×192 PNG rasterized from `src/app/icon.svg`       |
| `public/icon-512.png`      | New: 512×512 PNG rasterized from `src/app/icon.svg`       |
| `src/app/layout.tsx`       | `viewport.themeColor` entries for light and dark          |
| `tests/e2e/pwa.spec.ts`    | New: head link, manifest members, decoded icon dimensions |
| `docs/operations/setup.md` | §6 "Install it as an app" paragraph                       |
| `docs/log.md`              | `Decision` entry for this brief                           |

## Acceptance Criteria

Agent-verifiable:

- [ ] `GET /manifest.webmanifest` returns `200` and parses as JSON with `name`, `short_name`,
      `start_url` `/`, `display: 'standalone'`, and icons covering a 192 px and a 512 px PNG.
- [ ] The served page's `<head>` links that manifest, and the linked URL returns `200`.
- [ ] `public/icon-192.png` and `public/icon-512.png` are `image/png` and decode to exactly
      192×192 and 512×512, proved in `tests/e2e/pwa.spec.ts`.
- [ ] `pnpm run test:e2e` passes, including the new spec on both the `desktop` and `mobile`
      projects.
- [ ] `package.json` gains no dependency, and no service worker is registered by the page.
- [ ] `pnpm run verify` and the OKF bundle validator pass.

Human-only (the user, from the phone):

- [ ] Chrome offers **Install app** for `https://<machine>.<tailnet>.ts.net:8443/`, and
      installing adds the dashboard icon to the home screen.
- [ ] Launching the icon opens the dashboard without browser chrome, and Refresh inside it
      updates a card, adding a new `collector_runs` row.

## Testing

- Focused: `pnpm exec playwright test tests/e2e/pwa.spec.ts`.
- Broader: `pnpm run test:e2e` (desktop and Pixel 7 projects).
- Documentation surfaces: the OKF validator,
  `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`.
- Live, done by the user with the phone: the install offer, the standalone launch, and a
  Refresh inside the installed window. An agent cannot operate the phone, so report which live
  checks were actually performed.
- `pnpm run verify` is the final gate.

## Open Questions
