"""Mirror the KSE Images master folder into KS Installer's gallery source."""
import argparse
import csv
import filecmp
import io
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from build_gallery import ROOT, png_files

MASTER = ROOT.parent.parent / 'KSE Images'
FOLDERS = {'Model Images': 'model-images', 'Wallpapers': 'wallpapers', 'Splash': 'startup-screens'}


def main(master=MASTER):
    # Snapshot all three collections before pruning anything. A missing folder
    # is different from an intentionally empty collection.
    with TemporaryDirectory(dir=ROOT) as tmp:
        staging = Path(tmp)
        listed = set()
        for source, group in FOLDERS.items():
            folder = Path(master) / source
            if not folder.is_dir():
                raise SystemExit(f'Missing master folder: {folder}')
            target = staging / group
            target.mkdir()
            for image in png_files(folder):
                shutil.copyfile(image, target / image.name)
                listed.add(f'{group}/{image.name}')

        catalog = ROOT / 'catalog.csv'
        kept = io.StringIO(newline='')
        with catalog.open(encoding='utf-8', newline='') as stream:
            rows = csv.DictReader(stream)
            writer = csv.DictWriter(kept, fieldnames=rows.fieldnames, lineterminator='\n')
            writer.writeheader()
            writer.writerows(row for row in rows if row['path'] in listed)

        for group in FOLDERS.values():
            folder = ROOT / group
            folder.mkdir(exist_ok=True)
            for image in png_files(folder):
                if f'{group}/{image.name}' not in listed:
                    image.unlink()
                    print('Removed', image.relative_to(ROOT))
            for image in png_files(staging / group):
                destination = folder / image.name
                if not destination.exists() or not filecmp.cmp(image, destination, shallow=False):
                    image.replace(destination)
                    print('Updated', destination.relative_to(ROOT))

        if kept.getvalue() != catalog.read_text(encoding='utf-8'):
            staged = staging / catalog.name
            staged.write_text(kept.getvalue(), encoding='utf-8')
            staged.replace(catalog)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--master', type=Path, default=MASTER)
    main(parser.parse_args().master)
