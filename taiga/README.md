# Taiga fork: what is customized here

Fork of dotnetdreamer/open-screenshot-generator (MIT), customized for one
person's store release workflow. Upstream stays the base; everything personal
lives in this folder or is listed below, so merging upstream updates stays easy.

## 1. Taiga templates (pick the base style per app)

Two templates in `public/data/projects/`, registered under the **Taiga Custom**
tab in `src/lib/templateCategories.ts`:

| File | Base style | When |
| --- | --- | --- |
| `taiga-md3.json` | Material Design 3 (baseline roles: primary `#6750A4`, primaryContainer `#EADDFF`, surface `#FEF7FF`, onSurface `#1D1B20`) | The app itself is Material Design 3 |
| `taiga-glass.json` | Simple Glass (deep navy `#0B1E3A` to `#1D3A5F`, soft blue white text, glass panels) | The app itself is Simple Glass |

Layout, artboards (5, iPhone size) and Japanese copy are identical in both, so
switching the base style never changes the story. Headlines are placeholders in
Japanese; replace them with the app's real copy. Font is Noto Sans JP.
Preview strips live in `public/data/projects/previews/taiga-*.png`.

After adding or renaming a template, run `npm run gen:ai-catalog` so the AI
agent catalog stays in sync (upstream CONTRIBUTING rule).

## 2. store_listing_pack integration

`taiga/render_to_pack.py` runs the CLI (`fill`, `render`, `verify`) and places
the PNGs into the fixed pack layout used by the store_listing_pack skill:

```
~/workspace/store-packs/<app-slug>/<version>/02_images/screenshots/<store>/<device>/
```

With `--validate` it also runs that skill's `validate_pack.py` at the end.
Screenshots must be real screens of the app; this script only moves files the
CLI rendered from the shots you give it.

## 3. House defaults

- Base locale is Japanese: `DEFAULT_BASE_LOCALE = 'ja'` in
  `src/lib/i18n/locales.ts` (upstream default is `en-US`). Additional locale
  prepared by default: `en-US`.
- Projects stay local by default. Cloud save, live collaboration and direct
  store uploads are opt in per project, never on by default.
- The shared record of these defaults is `taiga/taiga-defaults.json`; scripts
  read it instead of hardcoding values.

## Upstream sync

`upstream` remote points at dotnetdreamer/open-screenshot-generator. Merge
upstream `main` into this fork's `main`; conflicts are expected to be limited
to `src/lib/i18n/locales.ts` (one line) and `src/lib/templateCategories.ts`
(the Taiga Custom entry).
