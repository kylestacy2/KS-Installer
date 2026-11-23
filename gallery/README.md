# KSE Image Gallery for the TX16S MK3

[Open the gallery](https://kylestacy2.github.io/KS-Installer/gallery/) · [Radio installer](https://kylestacy2.github.io/KS-Installer/)

Select an image to preview it on the 800 × 480 KSE Touch dashboard in Transparent mode. Try different model and wallpaper combinations using the selector below the screen. Splash screens also have an **At startup** view. The preview uses the electric dashboard layout with sample telemetry.

| Collection | Files to copy onto the radio |
| --- | --- |
| [Model images](model-images/) | Full-size aircraft PNGs in `/IMAGES/`. Match the filename to the aircraft name for KSE Touch's automatic lookup. |
| [Wallpapers](wallpapers/) | 800 × 480 backgrounds in `/IMAGES/Wallpapers/`. Choose **Appearance → Wallpaper & Startup** and apply the background. |
| [Startup screens](startup-screens/) | 800 × 480 splash screens in `/IMAGES/Wallpapers/`. Choose and apply the startup image on the same settings page. |

Use **Download PNG** on a card or preview page to save one image. Each collection has a ZIP. **Download all images** includes all three collections. Unzip a pack and merge its `IMAGES` folder into your SD card. The model pack preserves full-size originals and their filenames. A compact 192 × 114 thumbnail with a short filename is available on each model's preview page for the EdgeTX model picker.

For transparent tiles on the radio, set **Dashboard → Options → Dashboard theme** to **Transparent** and turn off shared theme matching. For a standard EdgeTX theme, save a copy of its current background and place your chosen wallpaper in the theme folder as `background_800x480.png`.

[KSE Touch guide](https://github.com/kylestacy2/KSE-Touch#appearance) · [EdgeTX theme files](https://github.com/EdgeTX/themes/blob/main/structure.md) · [EdgeTX model images](https://manual.edgetx.org/color-radios/radio-settings/storage)

## Sync artwork

Maintain the artwork in `Flying/KSE Images`, beside the KS Installer checkout. Its `Model Images`, `Wallpapers` and `Splash` subfolders map to `gallery/model-images/`, `gallery/wallpapers/` and `gallery/startup-screens/`. From the KS Installer checkout, run `python3 gallery/sync_images.py`, then `python3 tools/build-site.py`. Commit the changes, including deletions, and push to `main` to publish the combined site. Each sync mirrors PNG filenames and original bytes and removes catalog rows for deleted files. An empty collection clears that category. A missing master subfolder stops the sync.

The build preserves model PNGs and fits wallpaper and startup downloads to 800 × 480. The complete SD pack stores identical files with the same installation path once. Different images with the same installation path get an `alt-` prefix for the additional copy. To supply a display title or a short EdgeTX thumbnail filename, add a row to `catalog.csv`.

## Preview locally

From the KS Installer checkout, install Pillow with `python3 -m pip install -r gallery/requirements.txt`, run `python3 tools/build-site.py`, then open `_site/gallery/index.html` in a browser. The artwork previews and downloads work offline. To use the installer too, serve `_site` on localhost; see the main README.

## Publish on GitHub Pages

The KS Installer repository owns hosting. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. Push to `main` or run **Actions → Publish KS Installer → Run workflow**. The workflow rebuilds the installer, gallery, per-image previews and ZIP packs from one repository.
