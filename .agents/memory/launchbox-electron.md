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

## rcedit (icon stamping) MUST be in asarUnpack or the .exe icon silently stays default
`stampSfxIcon` uses `rcedit`, which spawns a bundled native binary (`rcedit-x64.exe`).
A child process CANNOT be executed from inside `app.asar`, so in the packaged Builder
the spawn throws, the try/catch swallows it, and export falls back to the default icon —
the user sees "the icon never matches". The save path and `WRITE_BASE/data/icon-source.<ext>`
resolution are NOT the bug. **Fix:** `build.asarUnpack: ["**/node_modules/rcedit/**"]` in
package.json so the binary lives in `app.asar.unpacked`. `png-to-ico` is pure JS — it does
NOT need unpacking. **How to apply:** any new dependency that spawns a bundled binary needs
the same asarUnpack treatment.

## Export "Resumo" summary refreshes only on the saves that call updateExportSummary
`updateExportSummary(config)` is NOT auto-bound to config changes — each save handler must
call it explicitly. Brand/banner/leads/icon saves do; the Content save (`persistContent`)
originally did NOT, so adding modules left the Export tab showing "0 módulos" until reload.
**How to apply:** any new save flow that changes a summarized field must call
`updateExportSummary(updated)` with the fresh config returned by the IPC handler.

## Builder tab order = button order in #tabs nav; data-tab drives panels, not position
Tab order is purely the DOM order of `<button class="tab" data-tab="...">` in `#tabs`;
the `tab-num` spans and the PASSO comments are cosmetic and must be kept in sync manually.
Panels (`data-panel`) are shown/hidden by `data-tab` match, so reordering tab buttons does
NOT require reordering the `<section>` panels. Current order: brand1, leads2, banners3,
content4, icon5, export6 (export deliberately last).

## Renaming the Builder app: change display name only, NOT app.setName
The packaged Builder's writable data (project-config.json, assets) lives under
`app.getPath('userData')` = `%AppData%\<app.setName>`. So when renaming the app, change
ONLY the display/product strings (package.json productName + nsis.shortcutName +
description/author, main.js builderWindow `title`, index.html `<title>` + `.brand-title`
fallback, and `app.brand_title` in all 10 locales). Do NOT change
`app.setName('LaunchBox Builder')` or you orphan the user's existing course in the old
%AppData% folder. Also DO NOT touch Viewer strings (`LaunchBox Viewer.exe`,
`app.setName('LaunchBox Viewer')`, the SFX `RunProgram`) — renaming breaks the export
RunProgram path match. `DEFAULT_CONFIG.brand.title` is the default COURSE brand, not the
app name — leave it. Easy-to-miss leaks: the export save-dialog filter `name` and the
`.brand-title` HTML fallback text.

## Builder APP icon (its own exe/window) vs course .exe icon — two separate mechanisms
The Builder's own icon = electron-builder `build.win.icon` (`build/icon.ico`, multi-size)
for the installed exe/installer + a `BrowserWindow({icon})` PNG (put it under `src/builder/`
so it's inside the packaged files glob) for the running window. This is UNRELATED to the
course `Curso.exe` icon, which is stamped onto the SFX stub via rcedit at export time.
Generate `.ico` from any image with ImageMagick: `magick in.jpg -define
icon:auto-resize=256,128,64,48,32,16 build/icon.ico` (ImageMagick is available on Replit).

## Two banners (top + bottom), independent slots
Model is `marketing.banners = { top:{enabled,image,url}, bottom:{enabled,image,url} }`.
`migrateConfig()` (called in readConfig after deepMerge) maps the legacy single
`marketing.banner` (which had a `position` field) into the matching slot. Viewer is
read-only (no saveLanguage) — the language selector switches live for the session
only, it does not persist.

## Builder image-preview CSS must constrain the <img>, or it breaks the whole layout
Every Builder preview (logo, both banners, icon) puts a raw `<img>` inside a
`.logo-preview-wrap`-style box; `setImagePreview()` only toggles a `.visible` class.
If the preview `<img>` has NO size cap, a large source image renders at natural size,
overflows the panel width, creates horizontal scroll and pushes the sidebar/menu
off-screen — looks like the UI is "locked". **Rule:** any new preview needs a
`.<x>-preview-wrap img { max-width:100%; max-height:N; width/height:auto;
object-fit:contain }` rule (and `overflow:hidden` on the wrap). **Why:** this bit the
banner preview (CSS targeted a stale single-banner id `#banner-image-preview` after the
split into top/bottom slots) and would have bitten the icon preview too.

## Icon save = dedicated "Ícone" tab with explicit Save button
The icon picker is its own Builder tab (`data-panel="icon"`, 6th tab), NOT inside Export.
Flow is pick→preview only; persistence happens on the explicit "Guardar Ícone" click via
`export:saveIcon`. Picker uses a plain `<button>` (no `<label for>`+hidden file input).
`saveIcon` accepts `{sourcePath}` or `{removeIcon:true}`; allowed source exts are
`.ico/.png/.jpg/.jpeg/.gif/.webp/.bmp` (kept in lockstep across the picker filter,
`ICON_ALLOWED_EXTS` validation, and `ICON_SOURCE_NAMES` cleanup list). Conversion to the
final .exe icon still goes through `nativeImage`+`png-to-ico` with graceful fallback, so
exotic formats that nativeImage can't decode just fall back to the default icon — they
never block saving or export.

## Lead capture
Lead capture is EXCLUSIVELY via the provider HTML form (`marketing.leads.formHtml`). The native
First/Last/Email form was removed. Unlock = provider form submit interception OR the
"Já me inscrevi" (#optin-access) button; both call hideOptinGate().
