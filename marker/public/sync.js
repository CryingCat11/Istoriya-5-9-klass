// Связывает тетрадь с кабинетом учителя: ответы из localStorage уходят на сервер
(function () {
  const m = window.MARKER;
  if (!m) return;
  const resetFlag = 'marker-reset-' + m.work;
  let pendingReset = false;
  let resetting = false;

  // Перед запуском тетради кладём в localStorage то, что сохранено на сервере
  try {
    if (sessionStorage.getItem(resetFlag)) {
      pendingReset = true;
      localStorage.removeItem(m.key);
    } else if (m.state) localStorage.setItem(m.key, m.state);
    else localStorage.removeItem(m.key);
  } catch (e) {}

  let revision = m.revision;
  let stopped = m.submitted;
  let timer = null;
  let busy = false;
  let again = false;
  let bar, statusText, button;

  const proto = Storage.prototype;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  proto.setItem = function (key, value) {
    setItem.call(this, key, value);
    if (this === window.localStorage && key === m.key) schedule();
  };
  proto.removeItem = function (key) {
    removeItem.call(this, key);
    if (this === window.localStorage && key === m.key && document.readyState !== 'loading') {
      // Учитель стёр тетрадь: если страница сейчас перезагрузится, пустая тетрадь уйдёт на сервер уже после загрузки
      resetting = true;
      try { sessionStorage.setItem(resetFlag, '1'); } catch (e) {}
      schedule();
    }
  };

  const time = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function say(text, tone) {
    if (!statusText) return;
    statusText.textContent = text;
    bar.dataset.tone = tone || '';
  }
  function report() {
    try { return typeof window.notebookReport === 'function' ? window.notebookReport() : ''; } catch (e) { return ''; }
  }
  function schedule() {
    if (stopped) return;
    say('Сохраняю…');
    clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  }
  async function post(action, body, keepalive) {
    const response = await fetch('/learn/' + m.work + '/' + action, {
      method: 'POST', keepalive,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body),
    });
    let result = {};
    try { result = await response.json(); } catch (e) {}
    return { ok: response.ok, result };
  }
  function handle(result) {
    if (result.state === 'submitted') {
      stopped = true;
      showSubmitted();
    } else if (result.state === 'conflict') {
      stopped = true;
      say('Тетрадь изменилась на другом устройстве. Обнови страницу, чтобы продолжить.', 'warn');
      button.hidden = true;
    } else if (result.state === 'login') {
      stopped = true;
      say('Вход закончился. Открой ссылку от учителя ещё раз.', 'warn');
      button.hidden = true;
    } else say('Не удалось сохранить. Обнови страницу.', 'warn');
  }
  async function flush(keepalive) {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      let state = '';
      try { state = localStorage.getItem(m.key) || ''; } catch (e) {}
      const { ok, result } = await post('save', { revision, state, report: report() }, keepalive);
      if (ok) {
        revision = result.revision;
        resetting = false;
        try { sessionStorage.removeItem(resetFlag); } catch (e) {}
        say('Сохранено в ' + time(), 'ok');
      } else handle(result);
    } catch (e) {
      say('Нет связи. Ответы сохранятся, когда она вернётся.', 'warn');
      timer = setTimeout(flush, 5000);
    } finally {
      busy = false;
      if (again) { again = false; flush(); }
    }
  }
  function showSubmitted() {
    say('Тетрадь сдана. Учитель видит твои ответы, изменения больше не сохраняются.', 'done');
    button.hidden = true;
  }

  let confirming = false;
  async function submit() {
    if (!confirming) {
      confirming = true;
      button.textContent = 'Точно сдать? Нажми ещё раз';
      setTimeout(() => { confirming = false; if (!stopped) button.textContent = 'Сдать тетрадь'; }, 4000);
      return;
    }
    button.disabled = true;
    await flush();
    if (stopped) return;
    try {
      const { ok, result } = await post('submit', { revision });
      if (ok) { stopped = true; showSubmitted(); } else handle(result);
    } catch (e) {
      say('Нет связи. Попробуй сдать ещё раз через минуту.', 'warn');
    }
    button.disabled = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    bar = document.createElement('div');
    bar.className = 'marker-bar';
    bar.setAttribute('role', 'status');
    const who = document.createElement('b');
    who.textContent = m.name;
    statusText = document.createElement('span');
    button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Сдать тетрадь';
    button.addEventListener('click', submit);
    const link = document.createElement('a');
    link.href = '/learn';
    link.textContent = 'Мои тетради';
    bar.append(who, statusText, link, button);
    document.body.append(bar);
    if (m.submitted) showSubmitted();
    else if (pendingReset) schedule();
    else say('Ответы сохраняются сами');
  });
  addEventListener('pagehide', () => { if (timer && !resetting) flush(true); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer && !resetting) flush(true); });
})();
