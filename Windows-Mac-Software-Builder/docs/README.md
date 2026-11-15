# Multilingual user manual

The manual has four chapters in each of the ten application languages, plus a cover and linked language index (42 pages). Content is based on the published 2.6.9 application and the 2.6.10 menu and PKG changes.

To rebuild the documentation, provide Playwright and a local Chromium browser, then run `node docs/generate-manual.cjs <output-directory>`. Set `BROWSER_PATH` when Chrome is installed elsewhere. These documentation tools are not application runtime requirements.

The generator checks every page against its footer before writing the tagged PDF. Review rendered pages after content changes, especially Arabic, Bengali, Hindi and Chinese. Never describe a PKG as successfully built until the native installer checks and release publication have passed.
