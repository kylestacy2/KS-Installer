"""Build the downloadable gallery from the three PNG folders."""
import csv
import filecmp
import hashlib
import html
import json
import re
import shutil
from pathlib import Path
from string import Template
from tempfile import TemporaryDirectory
from urllib.parse import quote
from zipfile import ZipFile

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
COLLECTIONS = [
    ('wallpapers', 'Wallpapers', 'IMAGES/Wallpapers', 'Download wallpaper pack'),
    ('model-images', 'Model images', 'IMAGES', 'Download model pack'),
    ('startup-screens', 'Startup screens', 'IMAGES/Wallpapers', 'Download startup pack'),
]


def short_name(stem):
    slug = re.sub(r'[^a-z0-9]', '', stem.lower())
    if 0 < len(slug) <= 9:
        return slug
    suffix = hashlib.sha256(stem.encode()).hexdigest()[:4]
    return (slug[:5] or 'model') + suffix


DEFAULT_MODEL = Path('model-images/Stratos 700 #1.png')
DEFAULT_WALLPAPER = Path('wallpapers/01_Cobalt_Glass.png')
FEATURE = Path('wallpapers/Tangerine cobalt solar tide-2.png')
INSTALL = {
    'model-images': 'Copy the original to /IMAGES/. Match the filename to the aircraft name reported to KSE Touch.',
    'wallpapers': 'Copy to /IMAGES/Wallpapers/ and apply as your background in Appearance → Wallpaper &amp; Startup.',
    'startup-screens': 'Copy to /IMAGES/Wallpapers/ and apply as your startup image in Appearance → Wallpaper &amp; Startup.',
}
MODE_SWITCH = """<fieldset class="switches"><legend>Preview mode</legend>
<label><input type="radio" name="mode" checked> KSE Touch Transparent</label>
<label><input id="boot" type="radio" name="mode"> At startup</label></fieldset>"""


def preview_path(path):
    return Path('preview') / path.parent / (path.stem + '.html')


def download_path(path):
    # Finder allows color separators that FAT-formatted radio cards cannot store.
    return path.with_name(path.name.replace(':', '-'))


def name_for(path, catalog):
    return catalog.get(path.as_posix(), {}).get('title') or path.stem.replace('_', ' ')


def tile_markup():
    metrics = [
        ('GOV MODE', 'ACTIVE', '', '', '#16ea80', ''), ('HEAD RPM', '2008', 'RPM', 'MAX 2400', '#ffffff', '#e0e6ea'),
        ('BEC OUTPUT', '8.0', 'V', 'LOW 7.6V', '#ffffff', ''), ('ESC TEMP', '60', '°C', 'MAX 100°C', '#ffffff', '#ff811c'),
        ('CURRENT', '197', 'AMPS', 'MAX 250A', '#ffffff', '#00e486'), ('CELL VOLT', '3.95', 'V', 'LOW 3.57V', '#ffffff', ''),
        ('USED CAPACITY', '1848', '', 'mAh', '#ffffff', ''), ('P3 12S 47.4V', '57', '%', '', '#ffffff', '#0de47d'),
    ]
    result = []
    for i, (label, value, unit, foot, color, bar) in enumerate(metrics):
        if i < 4:
            x, y, h = 404 + (i % 2) * 198, 62 + (i // 2) * 117, 109
        else:
            x, y, h = 8 + (i - 4) * 198, 296, 96
        value_y = 60 if i < 4 else 56
        foot_color = '#ffcc35' if foot.startswith('MAX') else '#d2dce6'
        meter = ''
        if bar:
            bar_h = 23 if i == 7 else 3
            meter = f'<rect x="10" y="{h-bar_h-3}" width="170" height="{bar_h}" fill="#273341"/><rect x="10" y="{h-bar_h-3}" width="{97 if i == 7 else 120}" height="{bar_h}" fill="{bar}"/>'
        result.append(f'''<g transform="translate({x} {y})"><rect x=".5" y=".5" width="189" height="{h-1}" rx="6" fill="#080c12" fill-opacity=".451" stroke="#5d6b79"/>
          <text x="11" y="21" font-size="17" fill="#d2dce6">{label}</text>
          <text x="180" y="{value_y}" text-anchor="end" font-size="32" fill="{color}">{value} <tspan font-size="17" fill="#d2dce6">{unit}</tspan></text>
          <text x="180" y="{h-13 if bar else h-6}" text-anchor="end" font-size="17" fill="{foot_color}">{foot}</text>{meter}</g>''')
    return ''.join(result)


def image_card(path, title, size):
    url = quote(path.as_posix())
    page = quote(preview_path(path).as_posix())
    label = html.escape(title)
    search = html.escape((title + ' ' + path.stem).lower())
    return f'''<article class="card" data-search="{search}">
        <a class="picture" href="{page}" aria-label="Preview {label} on KSE Touch">
          <img src="{url}" width="{size[0]}" height="{size[1]}" loading="lazy" alt="{label}">
        </a>
        <div class="card-body"><h3><a href="{page}">{label}</a></h3><p class="meta">{size[0]} × {size[1]} px</p>
        <div class="actions"><a href="{page}">Preview</a><a href="{url}" download>Download PNG ↓</a></div></div>
    </article>'''


def write_detail(out, path, size, title, category, pack_label, thumb, catalog, detail_template):
    group = path.parent.name
    is_model = group == 'model-images'
    preferred = DEFAULT_WALLPAPER if is_model else DEFAULT_MODEL
    candidates = [p.relative_to(ROOT) for p in png_files(ROOT / preferred.parent)]
    other = preferred if preferred in candidates else next(iter(candidates), None)
    model = path if is_model else other
    def asset_url(asset):
        return '../../' + quote(download_path(asset).as_posix()) if asset else ''
    options = []
    for candidate in candidates:
        selected = ' selected' if candidate == other else ''
        options.append(f'<option data-model-name="{html.escape(download_path(candidate).stem)}" value="{asset_url(candidate)}"{selected}>{html.escape(name_for(candidate, catalog))}</option>')
    compact = ''
    if thumb:
        compact = f'<details><summary>EdgeTX model picker</summary><p class="note">192 × 114 PNG with a short filename.</p><a href="../../{quote(thumb)}" download>Download thumbnail ↓</a></details>'
    output = out / preview_path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(detail_template.substitute(
        title=html.escape(title), group=group, category=category, category_lower=category.lower(),
        wallpaper_href=href_attr(asset_url(other if is_model else path)), model_href=href_attr(asset_url(model)),
        model_name=html.escape(download_path(model).stem) if model else '', tiles=tile_markup(),
        pair_hidden='' if candidates else 'hidden',
        pair_label='Preview wallpaper' if is_model else 'Preview model', pair_target='wallpaper' if is_model else 'model-image',
        options=''.join(options), switches=MODE_SWITCH if group == 'startup-screens' else '',
        dimensions=f'{size[0]} × {size[1]}', filename=html.escape(path.name), image=asset_url(path),
        install=INSTALL[group], pack_label=pack_label, compact=compact), encoding='utf-8')


def href_attr(url):
    return f'href="{url}"' if url else ''


def png_files(folder):
    if not folder.exists():
        return []
    return sorted((p for p in folder.iterdir() if p.suffix.lower() == '.png' and not p.name.startswith('.') and p.is_file()),
                  key=lambda p: p.name.casefold())


def build_group(out, group, heading, sd_folder, pack_label, catalog, detail_template):
    folder = ROOT / group
    cards = []
    used_names = set()
    files = png_files(folder)
    pack_path = Path('packs', group + '.zip')
    (out / pack_path.parent).mkdir(exist_ok=True)
    with ZipFile(out / pack_path, 'w') as pack:
        for source in files:
            relative = source.relative_to(ROOT)
            published = download_path(relative)
            dest = out / published
            if dest.exists():
                raise ValueError(f'Multiple source files map to {published}')
            dest.parent.mkdir(exist_ok=True)
            with Image.open(source) as im:
                im.load()
                if im.format != 'PNG':
                    raise ValueError(f'Expected a PNG: {relative}')
                size = im.size
                if group != 'model-images' and size != (800, 480):
                    size = (800, 480)
                    mode = 'RGBA' if im.has_transparency_data else 'RGB'
                    ImageOps.fit(im.convert(mode), size, method=Image.Resampling.LANCZOS).save(dest)
                else:
                    shutil.copyfile(source, dest)
                info = catalog.get(relative.as_posix(), {})
                title = info.get('title') or source.stem.replace('_', ' ')
                thumb = None
                if group == 'model-images':
                    alias = info.get('radio_name') or short_name(source.stem)
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,9}', alias) or alias.lower() in used_names:
                        raise ValueError(f'Choose a unique radio name in catalog.csv for {relative}')
                    used_names.add(alias.lower())
                    thumb = f'thumbnails/{alias}.png'
                    radio_path = out / thumb
                    radio_path.parent.mkdir(exist_ok=True)
                    art = ImageOps.contain(im.convert('RGBA'), (192, 114), Image.Resampling.LANCZOS)
                    canvas = Image.new('RGBA', (192, 114))
                    canvas.paste(art, ((192 - art.width) // 2, (114 - art.height) // 2))
                    canvas.save(radio_path)
            pack.write(dest, f'{sd_folder}/{dest.name}')
            write_detail(out, published, size, title, heading, pack_label, thumb, catalog, detail_template)
            cards.append(image_card(published, title, size))
    count = len(cards)
    link = f'<a class="pack" href="{pack_path}" download>{pack_label} ↓</a>' if count else ''
    section = f'''<section id="{group}" class="collection" data-collection>
      <div class="section-head"><h2>{heading} <small>{count}</small></h2>{link}</div>
      <div class="grid">{''.join(cards) or '<p>First images coming soon.</p>'}</div>
    </section>'''
    return section, count


def main(destination=None):
    with (ROOT / 'catalog.csv').open(encoding='utf-8', newline='') as stream:
        catalog = {row['path']: row for row in csv.DictReader(stream)}
    template = Template((ROOT / 'gallery.html').read_text(encoding='utf-8'))
    detail_template = Template((ROOT / 'detail.html').read_text(encoding='utf-8'))
    with TemporaryDirectory(dir=ROOT) as staging:
        out = Path(staging) / "site"
        out.mkdir()
        shutil.copyfile(ROOT / "gallery.css", out / "gallery.css")
        for script in ('gallery.js', 'preview.js'):
            shutil.copyfile(ROOT / script, out / script)
        sections = []
        total = 0
        for group in COLLECTIONS:
            section, count = build_group(out, *group, catalog, detail_template)
            sections.append(section)
            total += count
        # The installer uses checksums of the exact downloadable PNGs, including
        # resized wallpapers. Raw originals and thumbnails are never confused.
        items = []
        for folder, _, sd_folder, _ in COLLECTIONS:
            for source in png_files(ROOT / folder):
                relative = source.relative_to(ROOT)
                published = download_path(relative)
                asset = out / published
                with Image.open(asset) as image:
                    width, height = image.size
                    tile = out / 'tiles' / published.with_suffix('.webp')
                    tile.parent.mkdir(parents=True, exist_ok=True)
                    ImageOps.contain(image.convert('RGBA'), (320, 192), Image.Resampling.LANCZOS).save(tile, quality=75, method=4)
                items.append({
                    'id': published.as_posix(), 'group': folder,
                    'file': published.name, 'title': name_for(relative, catalog),
                    'path': f'{sd_folder}/{published.name}',
                    'size': asset.stat().st_size,
                    'sha256': hashlib.sha256(asset.read_bytes()).hexdigest(),
                    'width': width, 'height': height,
                })
        (out / 'catalog.json').write_text(json.dumps({'schema': 1, 'items': items}, indent=2) + '\n', encoding='utf-8')
        with ZipFile(out / 'packs/complete.zip', 'w') as combined:
            packed = {}
            reserved = {f'{sd_folder}/{p.name}'.casefold()
                        for group, _, sd_folder, _ in COLLECTIONS for p in png_files(out / group)}
            for folder, _, sd_folder, _ in COLLECTIONS:
                for asset in png_files(out / folder):
                    name = asset.name
                    member = f'{sd_folder}/{name}'
                    if member.casefold() in packed:
                        if filecmp.cmp(asset, packed[member.casefold()], shallow=False):
                            continue
                        while member.casefold() in reserved:
                            name = 'alt-' + name
                            member = f'{sd_folder}/{name}'
                    combined.write(asset, member)
                    packed[member.casefold()] = asset
                    reserved.add(member.casefold())
        wallpapers = [p.relative_to(out) for p in png_files(out / 'wallpapers')]
        feature = FEATURE if FEATURE in wallpapers else next(iter(wallpapers), None)
        featured = ''
        if feature:
            title = html.escape(name_for(feature, catalog))
            featured = (f'<a class="feature" href="{quote(preview_path(feature).as_posix())}">'
                        f'<img src="{quote(feature.as_posix())}" alt="Preview {title} on KSE Touch">'
                        f'<span>Featured wallpaper <b>{title} ↗</b></span></a>')
            with Image.open(out / feature) as image:
                ImageOps.fit(image.convert('RGB'), (560, 336), method=Image.Resampling.LANCZOS).save(out / 'cover.webp', quality=82)
        else:
            Image.new('RGB', (560, 336), '#203647').save(out / 'cover.webp')
        home = template.substitute(
            sections='\n'.join(sections), total=total,
            featured=featured,
        )
        (out / 'index.html').write_text(home, encoding='utf-8')
        target = Path(destination) if destination else ROOT / '_site'
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        out.rename(target)
    print(f'Built {total} images in {target}')


if __name__ == '__main__':
    main()
