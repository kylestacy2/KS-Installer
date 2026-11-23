import importlib.util
import json
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'gallery'))
import build_gallery as gallery
import sync_images as sync


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'gallery'
        self.root.mkdir()
        for name in ('gallery.html', 'detail.html', 'gallery.css', 'gallery.js', 'preview.js'):
            shutil.copyfile(ROOT / 'gallery' / name, self.root / name)
        (self.root / 'catalog.csv').write_text('path,title,radio_name\n')
        for folder, *_ in gallery.COLLECTIONS:
            (self.root / folder).mkdir()
        self.master = Path(self.temporary.name) / 'KSE Images'
        for folder in sync.FOLDERS:
            (self.master / folder).mkdir(parents=True)
        self.patch = patch.object(gallery, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.sync_patch = patch.object(sync, 'ROOT', self.root)
        self.sync_patch.start()
        self.addCleanup(self.sync_patch.stop)

    def image(self, path, size=(800, 480), color=(20, 80, 180, 130)):
        Image.new('RGBA', size, color).save(path)
        return path.read_bytes()

    def test_sync_keeps_original_bytes_and_mirrors_deletions(self):
        original = self.image(self.master / 'Model Images/Aircraft #1.png', (1600, 900))
        self.image(self.root / 'model-images/Removed.png')
        (self.root / 'catalog.csv').write_text('path,title,radio_name\nmodel-images/Removed.png,Old,old\nmodel-images/Aircraft #1.png,Kept,kept\n')
        sync.main(self.master)
        self.assertEqual((self.root / 'model-images/Aircraft #1.png').read_bytes(), original)
        self.assertFalse((self.root / 'model-images/Removed.png').exists())
        self.assertNotIn('Removed.png', (self.root / 'catalog.csv').read_text())
        self.assertIn('Aircraft #1.png', (self.root / 'catalog.csv').read_text())
        (self.master / 'Model Images/Aircraft #1.png').unlink()
        sync.main(self.master)
        self.assertEqual(gallery.png_files(self.root / 'model-images'), [])

    def test_missing_master_folder_stops_before_changing_any_collection(self):
        original = self.image(self.root / 'model-images/Keep.png')
        self.image(self.master / 'Model Images/New.png')
        (self.master / 'Splash').rmdir()
        with self.assertRaisesRegex(SystemExit, 'Missing master folder'):
            sync.main(self.master)
        self.assertEqual((self.root / 'model-images/Keep.png').read_bytes(), original)
        self.assertFalse((self.root / 'model-images/New.png').exists())

    def test_build_preserves_models_and_sizes_backgrounds_and_downloads(self):
        original = self.image(self.root / 'model-images/Nimbus Blue:Purple.png', (1200, 700))
        self.image(self.root / 'wallpapers/Color #1.png', (1600, 900))
        self.image(self.root / 'startup-screens/Startup.png')
        gallery.main()
        out = self.root / '_site'
        self.assertEqual((out / 'model-images/Nimbus Blue-Purple.png').read_bytes(), original)
        with Image.open(out / 'wallpapers/Color #1.png') as image:
            self.assertEqual(image.size, (800, 480))
            self.assertEqual(image.mode, 'RGBA')
        with Image.open(next((out / 'thumbnails').glob('*.png'))) as image:
            self.assertEqual(image.size, (192, 114))
        with ZipFile(out / 'packs/model-images.zip') as archive:
            self.assertEqual(archive.read('IMAGES/Nimbus Blue-Purple.png'), original)
        detail = (out / 'preview/model-images/Nimbus Blue-Purple.html').read_text()
        self.assertIn('../../../site-nav.css', detail)
        self.assertIn('src="../../preview.js"', detail)
        self.assertIn('Color%20%231.png', detail)
        self.assertNotIn('<script>', detail)
        catalog = json.loads((out / 'catalog.json').read_text())
        self.assertEqual(catalog['schema'], 1)
        self.assertEqual(len(catalog['items']), 3)
        for item in catalog['items']:
            image_path = out / item['id']
            self.assertEqual(item['sha256'], hashlib.sha256(image_path.read_bytes()).hexdigest())
            self.assertEqual(item['size'], image_path.stat().st_size)
            with Image.open(image_path) as image:
                self.assertEqual((item['width'], item['height']), image.size)
            with Image.open(out / 'tiles' / Path(item['id']).with_suffix('.webp')) as tile:
                self.assertLessEqual(tile.width, 320)
                self.assertLessEqual(tile.height, 192)
        self.assertEqual(catalog['items'][1]['path'], 'IMAGES/Nimbus Blue-Purple.png')

    def test_combined_pack_deduplicates_same_content_and_retains_different_collisions(self):
        self.image(self.root / 'wallpapers/Same.png')
        self.image(self.root / 'startup-screens/Same.png')
        self.image(self.root / 'wallpapers/Different.png')
        self.image(self.root / 'startup-screens/Different.png', color=(200, 50, 10, 255))
        gallery.main()
        with ZipFile(self.root / '_site/packs/complete.zip') as archive:
            self.assertEqual(len(archive.namelist()), 3)
            self.assertIn('IMAGES/Wallpapers/alt-Different.png', archive.namelist())

    def test_empty_gallery_builds_without_broken_default_image_urls(self):
        gallery.main()
        out = self.root / '_site'
        self.assertTrue((out / 'cover.webp').is_file())
        self.assertIn('Browse 0 wallpapers', (out / 'index.html').read_text())
        self.assertEqual(json.loads((out / 'catalog.json').read_text())['items'], [])
        with ZipFile(out / 'packs/complete.zip') as archive:
            self.assertEqual(archive.namelist(), [])

    def test_failed_build_leaves_previous_output_intact(self):
        gallery.main()
        before = (self.root / '_site/index.html').read_bytes()
        (self.root / 'wallpapers/Invalid.png').write_bytes(b'not an image')
        with self.assertRaises(Exception):
            gallery.main()
        self.assertEqual((self.root / '_site/index.html').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
