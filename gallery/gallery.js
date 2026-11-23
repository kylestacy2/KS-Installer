const search = document.getElementById('search');
search.addEventListener('input', () => {
  const query = search.value.trim().toLowerCase();
  let hits = 0;
  for (const section of document.querySelectorAll('[data-collection]')) {
    let count = 0;
    for (const card of section.querySelectorAll('.card')) {
      card.hidden = !card.dataset.search.includes(query);
      if (!card.hidden) count++;
    }
    section.hidden = count === 0 && !!query;
    hits += count;
  }
  const result = document.getElementById('matches');
  result.hidden = !query;
  result.textContent = hits ? hits + (hits === 1 ? ' image found' : ' images found') : 'No images match your search.';
});
for (const link of document.querySelectorAll('.browse nav a')) link.addEventListener('click', () => {
  search.value = ''; search.dispatchEvent(new Event('input'));
});
