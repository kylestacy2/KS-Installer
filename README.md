# KS Installer

[Open the radio installer](https://kylestacy2.github.io/KS-Installer/) · [Browse the artwork gallery](https://kylestacy2.github.io/KS-Installer/gallery/)

Use **Grab latest KSE Touch** to install the current release on a TX16S MK3 or MK3 MAX from a supported desktop browser. You can also choose a release ZIP you already have.

1. Load the release. In **Make it yours**, choose any model images, wallpapers or startup screens you want to add, or continue with the release as supplied.
2. Connect the radio in bootloader mode, select its SD and UF2 drives, and preview the changes.
3. Save the backup and install the update. The installer verifies the SD files before transferring firmware. Follow the reconnect instructions for final verification.

Selected artwork with the same filename replaces the SD copy. The backup includes those originals so the installer can restore them if an SD write fails before the firmware transfer. If you skip the backup, restoration is unavailable. If you resume a saved installation, its selected images must still match the gallery checksums recorded in the backup.

After installation, use **Appearance → Wallpaper & Startup** on the radio to apply a wallpaper or startup screen. For automatic model images, use a PNG in `/IMAGES/` whose filename matches the aircraft name.

The gallery also offers individual PNGs, model thumbnails and ZIP packs. You can preview a model against a wallpaper on the dashboard, or preview a startup image by itself.

## Local build

```sh
python3 -m pip install -r gallery/requirements.txt
python3 -m unittest discover -s tests -p 'test_*.py'
npm test
python3 tools/build-site.py
python3 -m http.server 8790 --directory _site
```

Open `http://localhost:8790/` to test the installer and gallery. The build verifies local links, gallery checksums, ZIP packs and the public firmware download against `release.json`. GitHub Actions publishes the generated site on pushes to `main`.

To update artwork from the master PNG collections, run `python3 gallery/sync_images.py` before building. See the [gallery guide](gallery/README.md).
