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

## Lead capture
Lead capture is EXCLUSIVELY via the provider HTML form (`marketing.leads.formHtml`). The native
First/Last/Email form was removed. Unlock = provider form submit interception OR the
"Já me inscrevi" (#optin-access) button; both call hideOptinGate().
