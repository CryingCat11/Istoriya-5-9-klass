import { notebooks, byGrade } from './notebooks.mjs';

const zone = process.env.MARKER_TZ || 'Europe/Moscow';
export const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, day: 'numeric', month: 'long' }).format(date);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(date);
  const today = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, day: 'numeric', month: 'long' }).format(new Date());
  return day === today ? 'сегодня в ' + time : day + ' в ' + time;
}

export function status(work) {
  if (work.submitted_at) return { code: 'done', label: 'Сдана ' + when(work.submitted_at) };
  if (work.updated_at && Date.now() - new Date(work.updated_at) < 120000) return { code: 'live', label: 'Пишет сейчас' };
  if (work.updated_at) return { code: 'draft', label: 'В работе, последнее изменение ' + when(work.updated_at) };
  if (work.opened_at) return { code: 'draft', label: 'Открыта ' + when(work.opened_at) + ', ответов пока нет' };
  return { code: 'new', label: 'Ещё не открыта' };
}

const notebookName = grade => `${grade} класс · «${byGrade.get(grade)?.title ?? ''}»`;

function page(title, body, tutor = false, home = tutor ? '/tutor' : '/learn') {
  const nav = tutor ? `<nav>
      <a href="/">Сайт</a><a href="/tutor">Работы</a><a href="/tutor/students">Ученики</a><a href="/tutor/new">Выдать тетрадь</a>
      <form method="post" action="/tutor/logout"><button class="link">Выйти</button></form>
    </nav>` : '';
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${h(title)} · Тетради по истории</title><link rel="stylesheet" href="/assets/cabinet.css">
<link rel="icon" href="/assets/mark.svg"><script src="/assets/cabinet.js" defer></script></head>
<body><header class="top"><div class="top-inner"><a class="brand" href="${home}">Тетради по истории</a>${nav}</div></header>
<main>${body}</main></body></html>`;
}

export function message(title, text) {
  return page(title, `<section class="sheet narrow"><h1>${h(title)}</h1><p>${h(text)}</p><p class="back"><a href="/">← На главную</a></p></section>`, false, '/');
}

export function login(error = '') {
  return page('Вход', `<section class="sheet narrow">
  <h1>Кабинет учителя</h1>
  <form method="post" action="/tutor/login" class="stack">
    <label>Код доступа<input name="code" type="password" autocomplete="current-password" required autofocus></label>
    ${error ? `<p class="error">${h(error)}</p>` : ''}
    <button class="btn">Войти</button>
  </form>
  <p class="back"><a href="/">← На главную</a></p></section>`, false, '/');
}

function workRow(work, withName = true) {
  const s = status(work);
  return `<li><a class="row" href="/tutor/work/${work.id}">
    <span class="dot ${s.code}"></span>
    <span class="what">${withName ? `<b>${h(work.name)}</b>` : ''}<span>${h(notebookName(work.grade))}</span></span>
    <span class="meta">${h(s.label)}</span></a></li>`;
}

export function tutorHome(works, hasStudents) {
  const body = works.length ? `<ul class="list">${works.map(work => workRow(work)).join('')}</ul>`
    : `<p class="muted">${hasStudents ? 'Пока ни одной работы. Выдай тетрадь ученику, и она появится здесь.' : 'Сначала добавь ученика, потом выдай ему тетрадь.'}</p>`;
  return page('Работы', `<section class="sheet">
    <div class="head"><h1>Работы</h1><a class="btn" href="${hasStudents ? '/tutor/new' : '/tutor/students'}">${hasStudents ? 'Выдать тетрадь' : 'Добавить ученика'}</a></div>
    ${body}</section>`, true);
}

export function studentList(students, error = '', value = '', removed = false) {
  const list = students.length ? `<ul class="list">${students.map(student => `<li><a class="row" href="/tutor/students/${student.id}">
      <span class="what"><b>${h(student.name)}</b></span><span class="meta">Личная ссылка и работы</span></a></li>`).join('')}</ul>`
    : '<p class="muted">Учеников пока нет.</p>';
  return page('Ученики', `<section class="sheet"><h1>Ученики</h1>
    ${removed ? '<p class="ok" data-flash>Ученик удалён вместе с его тетрадями.</p>' : ''}${list}
    <form method="post" action="/tutor/students" class="inline">
      <label>Новый ученик<input name="name" maxlength="80" value="${h(value)}" placeholder="Имя и первая буква фамилии" required></label>
      <button class="btn">Добавить</button>
    </form>${error ? `<p class="error">${h(error)}</p>` : ''}</section>`, true);
}

function copyField(link, label) {
  return `<div class="copy"><label>${h(label)}<input readonly value="${h(link)}" data-copy></label>
    <button type="button" class="btn quiet" data-copy-button>Скопировать</button></div>`;
}

export function studentDetail(student, works, link, renewed) {
  return page(student.name, `<section class="sheet">
    <p class="kicker"><a href="/tutor/students">Ученики</a></p><h1>${h(student.name)}</h1>
    ${renewed ? '<p class="ok" data-flash>Ссылка заменена. Старые ссылки и входы этого ученика больше не работают, ответы сохранены.</p>' : ''}
    ${copyField(link, 'Личная ссылка: по ней ученик видит все свои тетради')}
    <div class="head"><h2>Тетради</h2><a class="btn" href="/tutor/new?student=${student.id}">Выдать тетрадь</a></div>
    ${works.length ? `<ul class="list">${works.map(work => workRow(work, false)).join('')}</ul>` : '<p class="muted">Тетрадей пока нет.</p>'}
    <form method="post" action="/tutor/students/${student.id}" class="danger">
      <input type="hidden" name="version" value="${student.link_version}">
      <p class="muted">Если ссылку переслали кому-то ещё, замени её. Старые ссылки перестанут работать.</p>
      <button class="btn quiet">Заменить личную ссылку</button>
    </form>
    <div class="danger">
      <p class="muted">Ученик больше не занимается? Можно удалить его вместе со всеми тетрадями и ответами.</p>
      <a class="btn quiet" href="/tutor/students/${student.id}/delete">Удалить ученика</a>
    </div></section>`, true);
}

export function confirmRemove(student, count) {
  const works = count ? `Вместе с учеником удалятся ${count} ${plural(count, 'тетрадь', 'тетради', 'тетрадей')} и все ответы. ` : '';
  return page('Удалить ученика', `<section class="sheet narrow">
    <p class="kicker"><a href="/tutor/students/${student.id}">${h(student.name)}</a></p>
    <h1>Удалить ученика?</h1>
    <p>${works}Его ссылки перестанут работать. Вернуть удалённое нельзя.</p>
    <form method="post" action="/tutor/students/${student.id}/delete" class="inline">
      <button class="btn danger-btn">Удалить</button>
      <a class="btn quiet" href="/tutor/students/${student.id}">Отмена</a>
    </form></section>`, true);
}

function plural(n, one, few, many) {
  const tens = n % 100, units = n % 10;
  if (tens > 10 && tens < 20) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}

export function newWork(students, values = {}, error = '') {
  const options = students.map(student => `<option value="${student.id}"${student.id === values.student ? ' selected' : ''}>${h(student.name)}</option>`).join('');
  const grades = notebooks.map(item => `<label class="choice"><input type="radio" name="grade" value="${item.grade}"${String(item.grade) === String(values.grade) ? ' checked' : ''} required>
      <span><b>${item.grade} класс</b> «${h(item.title)}»</span></label>`).join('');
  return page('Выдать тетрадь', `<section class="sheet narrow"><h1>Выдать тетрадь</h1>
    <form method="post" action="/tutor/new" class="stack">
      <label>Ученик<select name="student" required><option value="">Выбери ученика</option>${options}</select></label>
      <fieldset><legend>Тетрадь</legend>${grades}</fieldset>
      <label>Записка ученику, по желанию<textarea name="note" maxlength="500" rows="3" placeholder="Например: начнём с этапа «Разведка»">${h(values.note)}</textarea></label>
      ${error ? `<p class="error">${h(error)}</p>` : ''}
      <button class="btn">Выдать и получить ссылку</button>
    </form></section>`, true);
}

export function reportHtml(report) {
  if (!report.trim()) return '<p class="muted">Ответов пока нет. Как только ученик начнёт писать, они появятся здесь.</p>';
  return report.split('\n').map(line => {
    if (!line.trim()) return '<div class="gap"></div>';
    const cut = line.indexOf(': ');
    const head = cut > 0 ? line.slice(0, cut) : '';
    if (head && head === head.toUpperCase() && /[А-ЯЁA-Z]/.test(head)) return `<p><b>${h(head)}</b> ${h(line.slice(cut + 2))}</p>`;
    return `<p>${h(line)}</p>`;
  }).join('');
}

export function tutorWork(work, link, created) {
  const s = status(work);
  return page(work.name + ', ' + work.grade + ' класс', `<section class="sheet" data-live="/tutor/work/${work.id}.json">
    <p class="kicker"><a href="/tutor">Работы</a></p>
    <h1>${h(work.name)}</h1>
    <p class="sub">${h(notebookName(work.grade))}</p>
    ${created ? '<p class="ok" data-flash>Тетрадь выдана. Отправь ученику ссылку ниже.</p>' : ''}
    ${copyField(link, 'Ссылка на эту тетрадь для ученика')}
    ${work.note ? `<blockquote class="note">${h(work.note)}</blockquote>` : ''}
    <div class="head"><h2>Ответы</h2><p class="state"><span class="dot ${s.code}" data-dot></span><span data-status>${h(s.label)}</span></p></div>
    <div class="report" data-report>${reportHtml(work.report)}</div>
    <form method="post" action="/tutor/work/${work.id}/reopen" class="danger" data-reopen ${work.submitted_at ? '' : 'hidden'}>
      <p class="muted">Ученик сдал тетрадь. Если нужно что-то дописать, верни её в работу.</p>
      <button class="btn quiet">Вернуть в работу</button>
    </form></section>`, true);
}

export function today(student, works) {
  const list = works.length ? `<ul class="list">${works.map(work => {
    const done = Boolean(work.submitted_at);
    return `<li><a class="row" href="/learn/${work.id}">
      <span class="dot ${done ? 'done' : work.updated_at ? 'draft' : 'new'}"></span>
      <span class="what"><b>${h(notebookName(work.grade))}</b>${work.note ? `<span>${h(work.note)}</span>` : ''}</span>
      <span class="meta">${done ? 'Сдана' : work.updated_at ? 'Продолжить' : 'Начать'}</span></a></li>`;
  }).join('')}</ul>` : '<p class="muted">Тетрадей пока нет. Учитель пришлёт ссылку, когда выдаст новую.</p>';
  return page('Мои тетради', `<section class="sheet narrow"><h1>${h(student.name)}, твои тетради</h1>${list}
    <p class="muted small">Ответы сохраняются сами. Можно закрыть страницу и продолжить потом, даже с другого устройства, если открыть ту же ссылку.</p></section>`);
}
