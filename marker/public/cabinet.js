// Копирование ссылок и живое обновление ответов в кабинете учителя
document.querySelectorAll('[data-copy-button]').forEach(button => {
  button.addEventListener('click', async () => {
    const field = button.parentElement.querySelector('[data-copy]');
    try {
      await navigator.clipboard.writeText(field.value);
    } catch (e) {
      field.select();
      document.execCommand('copy');
    }
    button.textContent = 'Скопировано';
    setTimeout(() => { button.textContent = 'Скопировать'; }, 1800);
  });
});

const live = document.querySelector('[data-live]');
if (live) {
  const report = live.querySelector('[data-report]');
  const dot = live.querySelector('[data-dot]');
  const label = live.querySelector('[data-status]');
  const reopen = live.querySelector('[data-reopen]');
  let last = '';
  async function refresh() {
    if (document.visibilityState !== 'visible') return;
    try {
      const response = await fetch(live.dataset.live, { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      dot.className = 'dot ' + data.code;
      label.textContent = data.label;
      reopen.hidden = !data.submitted;
      if (data.html !== last) {
        last = data.html;
        report.innerHTML = data.html;
      }
    } catch (e) {}
  }
  refresh();
  setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', refresh);
}

// Уведомления вроде «Ученик удалён» показываются один раз: адрес очищается, а через 5 секунд надпись исчезает
const flashes = document.querySelectorAll('[data-flash]');
if (flashes.length) {
  const url = new URL(location.href);
  ['removed', 'created', 'link'].forEach(key => url.searchParams.delete(key));
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  setTimeout(() => flashes.forEach(el => {
    el.classList.add('gone');
    setTimeout(() => el.remove(), 400);
  }), 5000);
}
