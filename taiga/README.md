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

`taiga/render_to_pack.py` builds and runs this checkout's CLI (`fill`, `render`,
`verify`). It reads this checkout's template catalog and places verified PNGs
into the pack layout used by the store_listing_pack skill:

```
~/workspace/store-packs/<app-slug>/<version>/02_images/screenshots/<store>/<device>/
```

Install the root and CLI dependencies with `npm ci` and `npm ci --prefix cli`.
Use Node 20.12+ and Python 3.10+. Build the local editor with `npm run build`,
or start this checkout with `npm run dev` and pass its local URL:

```bash
python3 taiga/render_to_pack.py --app-slug my-app --version 1.0.0 \
  --shots ./shots --template taiga-md3.json --store apple --device iphone \
  --editor-url http://127.0.0.1:9002
```

`taiga-md3`, `taiga-md3.json` and `template_taiga-md3` name the same template.
Use `taiga-glass` for the other style. With no template flag, the script uses
`defaultTemplate` from `taiga-defaults.json`. It exports the template's Japanese
and English text by default. `--locales ja` or `--locales en-US` selects one
language; the template must contain every language requested. The script does
not translate copy. Read the template text and replace its placeholders before
preparing a release.

| Store | Device | Output size |
| --- | --- | --- |
| `apple` | `iphone` (default) | 1206 × 2622 |
| `apple` | `ipad` | 2064 × 2752 |
| `google-play` | `android` (default), `phone` | 1080 × 1920 |
| `google-play` | `tablet-7` | 1080 × 1920 |
| `google-play` | `tablet-10` | 1440 × 2560 |

Unknown devices and combinations from different stores stop before rendering.
Apple and Google Play rules apply to the selected output, including image
counts for each language. `--pack-root <directory>` overrides the pack root.

Each run uses a fresh work directory. Only PNGs named by that run's render
manifest enter the pack. The script checks their names, sizes and language
counts, then verifies a staged copy. A successful run replaces the selected
store/device directory and writes `osg.manifest.json` there with image hashes,
the CLI and template hashes, and the verification result. Other devices and
versions stay in place. Failed rendering or validation keeps the existing
image directory. Runs that publish to the same app/version hold a lock while
checking and replacing its images.

With `--validate`, the script also runs the configured `validate_pack.py` on a
staged copy of the entire pack before replacing images. A missing validator or
a failing pack check stops the run. Prepare any other files that validator
requires in the pack first. Without `--validate`, the script checks the images
and does not claim the rest of the store listing is complete.

Screenshots must be real screens of the app. The script places the shots you
give it into the template and does not capture an app or upload store files.
The editor and catalog stay local; external fonts and artwork must already be
in the build or cache for this offline render.

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
