---
name: LaunchBox Pro Electron quirks
description: Non-obvious build/runtime gotchas for the icurator-pro Electron app (Builder + Viewer)
---

# LaunchBox Pro (icurator-pro/) — durable gotchas

## electron-builder config single source of truth
The Builder packaging config lives in `package.json` `build` key (not a separate `--config` file).
`build:builder` runs plain `electron-builder --win --x64`.
**Why:** when config sat only in `build-configs/builder.json` and electron-builder was ever
invoked without `--config`, it silently used defaults and did NOT copy `viewer-template`,
causing runtime ENOENT on `resources/viewer-template/resources/app.asar` during course export.
**How to apply:** keep extraResources (viewer-template copy with `filter:["**/*"]`) in package.json.
The Viewer template build is the exception — it still uses `build-configs/viewer-template.json`.
Two-stage build order is mandatory: `build:viewer-template` BEFORE `build:builder`.

## YouTube Error 153 = file:// referrer, not the regex
The viewer is loaded via `file://`. A YouTube `<iframe>` inside a file:// page sends a file://
referrer that YouTube rejects → Error 153. Fix was to render YouTube in a `<webview>` (top-level
youtube.com navigation, no file:// referrer), not to change the URL conversion.
**Why:** the embed-URL conversion was already correct; "fix the regex" does not resolve 153.
**How to apply:** keep YouTube on `<webview>`; CSS `.viewer-stage.fill` already sizes webview.

## Builder "Preview" window must reload on reopen
`createViewerWindow` reuses an existing preview window. It MUST call
`webContents.reload()` before `focus()` when reusing — otherwise content added
after the first preview (modules, logo, banner) never shows; user sees a stale
empty "Bem-vindo" screen. `readConfig()` has no cache (reads file each call), so
reload alone re-renders the latest project-config.json.

## deepMerge null-default crash silently wiped config (the real "double save" bug)
readConfig() = deepMerge(DEFAULT_CONFIG, parsed) wrapped in try/catch that returns
DEFAULT on error. deepMerge's guard `typeof defaults !== 'object'` does NOT catch
`null` (typeof null === 'object'), so a null default (brand.logo, banner.image,
icon) merged with a real saved value hit `Object.keys(null)` → throw → readConfig
returns DEFAULT (everything null/empty). Symptom: 1st save OK (returns in-memory
obj), 2nd save re-reads → crash → writes null over logo/banner; export shows
"No logo / 0 modules". **Fix:** guard must include `defaults === null`. Lesson:
any try/catch-returns-default config reader hides merge crashes — test round-trip
of null-default fields transitioning to concrete values.

## electron-builder DROPS nested app.asar in extraResources
Copying the Viewer template (win-unpacked) into the Builder via `extraResources`
silently SKIPS any file named `app.asar` — the folder copies, but
`viewer-template/resources/app.asar` is missing in the installed Builder →
export fails with ENOENT. The `extraResources.from` path is NOT the problem.
**Fix:** prune step renames `resources/app.asar` → `app.asar.bin` (not skipped);
`export:buildExe` renames it back to `app.asar` when staging the SFX. Keep both
the prune rename and the export rename in lockstep; accept `.asar` or `.bin` in
preflight checks for backward compat.

## Build-order footgun → preflight guard
ENOENT on `viewer-template/resources/app.asar` is almost always a build-ORDER
problem, not a wrong `extraResources.from` path (the path is correct). Building the
Builder without a fresh viewer template silently ships a broken installer.
`scripts/check-viewer-template.js` runs before `build:builder` and exits non-zero
if `win-unpacked/resources/app.asar` is missing. Use `npm run build:all` to do both
stages in order. npm `&&` chaining works on Windows (cmd.exe).

## Course .exe icon comes from the SFX stub, NOT win.icon
The course `Curso.exe` is a 7-Zip SFX: `[stub 7zsd_All_x64.sfx][SFX config][7z payload]`
concatenated. Its taskbar/Explorer icon is the icon embedded in the STUB PE, so
setting `win.icon` (electron-builder) or copying a `.ico` into the payload does
nothing to the final .exe icon. **Fix:** at export, stamp the icon onto a TEMP
COPY of the stub with `rcedit` BEFORE concatenation, then concat the stamped stub.
Accept png/jpg/ico (convert png/jpg→.ico via Electron `nativeImage` + `png-to-ico`).
**Why:** users uploaded an icon and saw the default one — the icon was applied to
the wrong artifact. **How to apply:** `png-to-ico`+`rcedit` are lazy-required with
graceful fallback (export must never fail if deps missing — user runs `npm install`
first on Windows); keep both as `dependencies` in package.json.

## Two banners (top + bottom), independent slots
Model is `marketing.banners = { top:{enabled,image,url}, bottom:{enabled,image,url} }`.
`migrateConfig()` (called in readConfig after deepMerge) maps the legacy single
`marketing.banner` (which had a `position` field) into the matching slot. Viewer is
read-only (no saveLanguage) — the language selector switches live for the session
only, it does not persist.

## Lead capture
Lead capture is EXCLUSIVELY via the provider HTML form (`marketing.leads.formHtml`). The native
First/Last/Email form was removed. Unlock = provider form submit interception OR the
"Já me inscrevi" (#optin-access) button; both call hideOptinGate().
