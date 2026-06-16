# Releasing Roary Pet (macOS build on GitHub)

Builds are produced by GitHub Actions (`.github/workflows/build.yml`) and published
to **GitHub Releases**, so anyone can download a ready `.dmg` after each version.

## How a release happens

The workflow triggers on a **version tag** (`v*`). On tag push it:
1. Builds macOS (`.dmg`, x64 + arm64), Windows (`.exe`), and Linux (AppImage/deb) on
   their native runners.
2. Creates a **published GitHub Release** for the tag and attaches all installers
   (auto-generated release notes). The release is gated on the macOS build succeeding,
   so a Windows/Linux failure never blocks the mac `.dmg`.

## Cut a release

```bash
# from the repo root, on main, working tree clean
npm version patch        # bumps package.json (e.g. 0.10.0 -> 0.10.1) and creates tag v0.10.1
git push --follow-tags   # pushes main + the tag → triggers the workflow
```

Use `npm version minor` / `npm version major` as appropriate. For a pre-release, tag
with a hyphen (e.g. `v0.11.0-beta.1`) — it's marked as prerelease automatically.

Watch the run under the repo's **Actions** tab. When green, the `.dmg` is on the
**Releases** page: https://github.com/AlexWolfGoncharov/roary-pet/releases

You can also run the workflow manually (Actions → Build & Release → Run workflow) to
produce build artifacts without creating a Release (the release step only runs on tags).

## Installing the macOS build (unsigned)

The app is **not code-signed** (no Apple Developer cert), so Gatekeeper blocks it on
first launch. To open:
- Right-click the app → **Open** → **Open** (once), **or**
- `xattr -dr com.apple.quarantine "/Applications/Roary Pet.app"`

To ship signed/notarized builds later, add an Apple Developer cert and set the
`CSC_LINK` / `CSC_KEY_PASSWORD` (and notarization `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
/ `APPLE_TEAM_ID`) secrets, then remove `CSC_IDENTITY_AUTODISCOVERY=false` from the mac
build step.

## Auto-update note

In-app auto-update is **enabled** and reads this fork's own GitHub Releases
(`AlexWolfGoncharov/roary-pet`; `autoUpdateCheck` default true, updater URLs and
`build.publish` point at the fork). Each tagged release publishes `latest*.yml`
feed files alongside the installers, which the updater consumes.

Caveat: the macOS app is **unsigned**, so it can't silently self-install on macOS
(Squirrel.Mac requires a valid signature). On macOS the updater notifies and opens
the Releases page for a manual `.dmg` download; Windows can self-update. Once the
mac build is signed/notarized, full in-app auto-update works on macOS too.
