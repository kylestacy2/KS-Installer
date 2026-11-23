"""Build and validate the installer and gallery as one GitHub Pages artifact."""
import importlib.util
import hashlib
import json
import re
import shutil
import sys
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
INSTALLER_ASSETS = {
    '.nojekyll', 'index.html', 'styles.css', 'site-nav.css', 'app.js',
    'core.js', 'download.js', 'fs.js', 'zip.js', 'backup-zip.js', 'demo.js', 'release.json', 'artwork.js',
}
GALLERY_FOLDERS = {'wallpapers', 'model-images', 'startup-screens', 'preview', 'thumbnails', 'packs', 'tiles'}


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.links = []
        self.ids = set()
        self.inline_scripts = False
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            assert attrs['id'] not in self.ids, f'Duplicate element id: {attrs["id"]}'
            self.ids.add(attrs['id'])
        if tag == 'script' and not attrs.get('src'):
            self.inline_scripts = True
        for attr in ('href', 'src'):
            if attrs.get(attr):
                self.links.append(attrs[attr])
        if tag == 'option' and attrs.get('value') and attrs['value'] not in {'model-images', 'wallpapers', 'startup-screens'}:
            self.links.append(attrs['value'])


def validate_payloads(site, manifest):
    # Old clients may still need a previously published immutable URL.
    # Validate every retained payload by its content address, and check the
    # active bundle member-by-member against the current release manifest.
    payloads = site / 'payloads'
    download = manifest['download']
    assert download['path'] == 'payloads/' + download['sha256'] + '.zip', 'Invalid download path'
    for payload in payloads.iterdir():
        assert payload.is_file() and re.fullmatch(r'[0-9a-f]{64}\.zip', payload.name), payload.name
        assert hashlib.sha256(payload.read_bytes()).hexdigest() == payload.stem, payload.name
    current = site / download['path']
    assert current.stat().st_size == download['size'], 'Release download size mismatch'
    records = [*manifest['files'], manifest['settings'], manifest['firmware']]
    with ZipFile(current) as archive:
        assert sorted(archive.namelist()) == sorted(record['archive'] for record in records), 'Release ZIP contents mismatch'
        for record in records:
            info = archive.getinfo(record['archive'])
            assert info.file_size == record['size'], info.filename
            assert hashlib.sha256(archive.read(info)).hexdigest() == record['sha256'], info.filename


def validate_site(site):
    site = site.resolve()
    assert {p.name for p in site.iterdir()} == INSTALLER_ASSETS | {'gallery', 'payloads'}, 'Unexpected publish root'
    files = [p for p in site.rglob('*') if p.is_file()]
    assert not any(p.is_symlink() for p in site.rglob('*')), 'Symlink in publish artifact'
    assert sum(p.stat().st_size for p in files) < 512 * 1024 * 1024, 'Unexpected publish size'
    pages = {}
    for path in files:
        relative = path.relative_to(site)
        if relative.parts[0] == 'gallery':
            assert path.suffix in {'.html', '.css', '.js', '.png', '.webp', '.zip', '.json'}, relative
            if path.suffix == '.json':
                assert relative.as_posix() == 'gallery/catalog.json', relative
            if len(relative.parts) > 2:
                assert relative.parts[1] in GALLERY_FOLDERS, relative
        if path.suffix in {'.html', '.css', '.js', '.json'}:
            text = path.read_text(encoding='utf-8')
            assert not re.search(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|-----BEGIN .*PRIVATE KEY|/Users/|/Volumes/)', text), relative
            if path.suffix == '.html':
                pages[path] = Page(text)
                assert not pages[path].inline_scripts, f'Inline script in {relative}'
                assert 'Content-Security-Policy' in text, f'Missing CSP in {relative}'
            if path.suffix == '.js':
                for imported in re.findall(r"from\s*['\"]([^'\"]+)['\"]", text):
                    assert imported.startswith('./') and (path.parent / imported).is_file(), imported
        if path.suffix == '.zip' and relative.parts[0] != 'payloads':
            assert relative.parts[:2] == ('gallery', 'packs'), 'Unexpected ZIP in publish artifact'
            with ZipFile(path) as archive:
                members = archive.namelist()
                assert len({n.casefold() for n in members}) == len(members), f'Duplicate SD paths in {relative}'
                for member in members:
                    parsed = PurePosixPath(member)
                    assert parsed.parts[0] == 'IMAGES' and '..' not in parsed.parts and parsed.suffix.lower() == '.png', member
                    assert not any(c in member for c in ':\\*?"<>|'), member
                assert archive.testzip() is None, f'Corrupt ZIP: {relative}'
    for path, page in pages.items():
        for link in page.links:
            parsed = urlsplit(link)
            if parsed.scheme or parsed.netloc:
                continue
            target = (path.parent / unquote(parsed.path)).resolve() if parsed.path else path
            assert target.is_relative_to(site), f'Link escapes site: {path}: {link}'
            if target.is_dir():
                target /= 'index.html'
            assert target.is_file(), f'Broken link: {path.relative_to(site)}: {link}'
            if parsed.fragment and target in pages:
                assert unquote(parsed.fragment) in pages[target].ids, f'Broken anchor: {link}'
    catalog = json.loads((site / 'gallery/catalog.json').read_text())
    assert catalog['schema'] == 1
    assert len({item['id'] for item in catalog['items']}) == len(catalog['items'])
    for item in catalog['items']:
        assert item['group'] in {'model-images', 'wallpapers', 'startup-screens'}
        assert item['id'] == item['group'] + '/' + item['file']
        assert '/' not in item['file'] and '\\' not in item['file'] and item['file'].lower().endswith('.png')
        assert item['path'] == ('IMAGES/' if item['group'] == 'model-images' else 'IMAGES/Wallpapers/') + item['file']
        asset = site / 'gallery' / item['id']
        assert asset.is_file() and asset.stat().st_size == item['size']
        assert hashlib.sha256(asset.read_bytes()).hexdigest() == item['sha256']
        assert (site / 'gallery/tiles' / Path(item['id']).with_suffix('.webp')).is_file()
    manifest = json.loads((site / 'release.json').read_text())
    assert manifest['board'] == 'tx16smk3' and manifest['firmwareWriteEnabled'] is True
    assert manifest['zip']['name'] == 'EdgeTXKSE.zip'
    assert re.fullmatch('[0-9a-f]{64}', manifest['zip']['sha256'])
    assert manifest['releaseURL'] == 'https://github.com/kylestacy2/KSE-Touch/releases/tag/' + manifest['id']
    validate_payloads(site, manifest)
    print(f'Validated {len(files)} published files and {len(pages)} pages; all local links and image ZIPs checked.')


def main():
    spec = importlib.util.spec_from_file_location('build_gallery', ROOT / 'gallery/build_gallery.py')
    gallery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gallery)
    with TemporaryDirectory(dir=ROOT) as temporary:
        staged = Path(temporary) / 'site'
        staged.mkdir()
        for name in INSTALLER_ASSETS:
            shutil.copyfile(ROOT / name, staged / name)
        (staged / 'payloads').mkdir()
        for payload in (ROOT / 'payloads').glob('*.zip'):
            if payload.is_symlink():
                raise ValueError(f'Unexpected payload symlink: {payload.name}')
            shutil.copyfile(payload, staged / 'payloads' / payload.name)
        gallery.main(destination=staged / 'gallery')
        validate_site(staged)
        destination = ROOT / '_site'
        if destination.exists():
            shutil.rmtree(destination)
        staged.rename(destination)
    print(f'Built installer and gallery: {destination}')


if __name__ == '__main__':
    main()
