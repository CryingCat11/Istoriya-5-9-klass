import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, dataAccess } from './lib/database.mjs';
import { byGrade, notebookPage } from './lib/notebooks.mjs';
import * as ui from './lib/views.mjs';

process.umask(0o077);
const demo = process.argv.includes('--demo');
const host = demo ? '127.0.0.1' : process.env.MARKER_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4318);
const tutorCode = demo ? randomBytes(18).toString('base64url') : process.env.MARKER_TUTOR_CODE;
if (!tutorCode || tutorCode.length < 24 || tutorCode.length > 256) {
  console.error('Задай MARKER_TUTOR_CODE длиной от 24 до 256 символов или запусти npm run demo.');
  process.exit(1);
}
const publicUrl = process.env.MARKER_URL ? new URL(process.env.MARKER_URL) : null;
if (publicUrl && (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.href !== publicUrl.origin + '/')) {
  throw new Error('MARKER_URL должен содержать только протокол и адрес приложения.');
}
const secure = publicUrl?.protocol === 'https:';
const dataFile = demo ? join(mkdtempSync(join(tmpdir(), 'marker-demo-')), 'notebooks.sqlite')
  : resolve(process.env.MARKER_DB || fileURLToPath(new URL('./data/notebooks.sqlite', import.meta.url)));
const data = dataAccess(openDatabase(dataFile));

if (demo) {
  const alina = data.addStudent('Алина К.');
  data.addStudent('Тимур С.');
  data.create(alina, 9, 'Начни с машины времени, потом разведка.');
}

const assets = new Map();
for (const [name, type] of [['cabinet.css', 'text/css; charset=utf-8'], ['cabinet.js', 'text/javascript; charset=utf-8'],
  ['sync.css', 'text/css; charset=utf-8'], ['sync.js', 'text/javascript; charset=utf-8'], ['mark.svg', 'image/svg+xml']]) {
  assets.set('/assets/' + name, [type, readFileSync(new URL('./public/' + name, import.meta.url))]);
}

const DAY = 86400;
const sign = (purpose, value) => createHmac('sha256', data.key).update(purpose + ':' + value).digest('base64url');
function equal(a, b) {
  const first = Buffer.from(a ?? '');
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function cookies(request) {
  return new Map((request.headers.cookie ?? '').split(/;\s*/).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)];
  }));
}
const makeCookie = (name, value, time) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${time}${secure ? '; Secure' : ''}`;
function session(purpose, id, duration) {
  const value = `${id}.${Math.floor(Date.now() / 1000) + duration}`;
  return value + '.' + sign(purpose, value);
}
function sessionId(purpose, token) {
  const [id, expiry, signature, ...rest] = (token ?? '').split('.');
  if (rest.length || !Number.isSafeInteger(Number(expiry)) || Number(expiry) <= Date.now() / 1000) return null;
  return equal(signature, sign(purpose, `${id}.${expiry}`)) ? id : null;
}
const tutorId = sign('tutor-code', tutorCode);
const origin = request => publicUrl?.origin || `http://${request.headers.host}`;
const studentIdentity = student => (student.link_version === 0 ? student.id : `${student.id}~${student.link_version}`);
const inviteToken = (student, workId = '') => sign('invite', studentIdentity(student) + '/' + workId);
const shareLink = (request, student, workId = '') =>
  `${origin(request)}/s/${student.id}/${workId ? workId + '/' : ''}${inviteToken(student, workId)}`;

const cabinetPolicy = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
const notebookPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";

function respond(response, status, type, value) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(value);
}
const html = (response, value, status = 200) => respond(response, status, 'text/html; charset=utf-8', value);
const json = (response, value, status = 200) => respond(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
function redirect(response, path, cookie) {
  response.setHeader('Cache-Control', 'no-store');
  if (cookie) response.setHeader('Set-Cookie', cookie);
  response.writeHead(303, { Location: path }).end();
}
const notFound = response => html(response, ui.message('Страница не найдена', 'Открой свою ссылку ещё раз или попроси учителя прислать новую.'), 404);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function formBody(request, limit = 32768) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'Открой страницу и попробуй ещё раз.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'Слишком много данных.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const id = '[a-f0-9-]{36}';
const invitePattern = new RegExp(`^/s/(${id})/(?:(${id})/)?([\\w-]{43})$`);
const studentPattern = new RegExp(`^/tutor/students/(${id})(/delete)?$`);
const workPattern = new RegExp(`^/tutor/work/(${id})(\\.json|/reopen)?$`);
const learnPattern = new RegExp(`^/learn/(${id})(?:/(save|submit))?$`);

async function tutor(request, response, path, search, isPost, loggedIn) {
  if (path === '/tutor/login') {
    if (!isPost) return loggedIn ? redirect(response, '/tutor') : html(response, ui.login());
    const form = await formBody(request);
    if (!equal(sign('tutor-code', (form.get('code') ?? '').replace(/\s+/g, '')), tutorId)) return html(response, ui.login('Код доступа не подошёл.'), 401);
    return redirect(response, '/tutor', makeCookie('marker_tutor', session('tutor', tutorId, DAY * 30), DAY * 30));
  }
  if (!loggedIn) return path.endsWith('.json') ? json(response, { state: 'login' }, 401) : redirect(response, '/tutor/login');
  if (path === '/tutor/logout' && isPost) return redirect(response, '/tutor/login', makeCookie('marker_tutor', '', 0));
  if (path === '/tutor' && !isPost) return html(response, ui.tutorHome(data.works(), data.students().length > 0));
  if (path === '/tutor/students') {
    if (!isPost) return html(response, ui.studentList(data.students(), '', '', search.has('removed')));
    const name = (await formBody(request)).get('name')?.trim();
    if (!name || name.length > 80) return html(response, ui.studentList(data.students(), 'Введи имя длиной до 80 символов.', name), 422);
    return redirect(response, '/tutor/students/' + data.addStudent(name));
  }
  const [, studentId, remove] = studentPattern.exec(path) ?? [];
  if (studentId) {
    const student = data.student(studentId);
    if (!student) return notFound(response);
    if (remove) {
      if (!isPost) return html(response, ui.confirmRemove(student, data.works(studentId).length));
      data.removeStudent(studentId);
      return redirect(response, '/tutor/students?removed=1');
    }
    if (isPost) {
      const version = (await formBody(request)).get('version');
      if (/^\d+$/.test(version ?? '')) data.rotateLink(studentId, Number(version));
      return redirect(response, '/tutor/students/' + studentId + '?link=renewed');
    }
    return html(response, ui.studentDetail(student, data.works(studentId), shareLink(request, student), search.get('link') === 'renewed'));
  }
  if (path === '/tutor/new') {
    const students = data.students();
    if (!students.length) return redirect(response, '/tutor/students');
    if (!isPost) return html(response, ui.newWork(students, { student: search.get('student') }));
    const form = await formBody(request);
    const values = Object.fromEntries(['student', 'grade', 'note'].map(key => [key, (form.get(key) ?? '').trim()]));
    let error = '';
    if (!data.student(values.student)) error = 'Выбери ученика из списка.';
    else if (!byGrade.has(Number(values.grade))) error = 'Выбери тетрадь.';
    else if (values.note.length > 500) error = 'Сократи записку до 500 символов.';
    if (error) return html(response, ui.newWork(students, values, error), 422);
    return redirect(response, '/tutor/work/' + data.create(values.student, Number(values.grade), values.note) + '?created=1');
  }
  const match = workPattern.exec(path);
  if (match) {
    const [, workId, action] = match;
    const work = data.get(workId);
    if (!work) return action === '.json' ? json(response, { state: 'missing' }, 404) : notFound(response);
    if (action === '/reopen' && isPost) {
      data.reopen(workId);
      return redirect(response, '/tutor/work/' + workId);
    }
    if (isPost) return notFound(response);
    const s = ui.status(work);
    if (action === '.json') return json(response, { code: s.code, label: s.label, submitted: Boolean(work.submitted_at), revision: work.revision, html: ui.reportHtml(work.report) });
    if (!action) return html(response, ui.tutorWork(work, shareLink(request, data.student(work.student_id), workId), search.has('created')));
  }
  return notFound(response);
}

const inviteRequired = response => html(response, ui.message('Открой свою ссылку',
  'Учитель присылает её вместе с тетрадью. По ней можно продолжить работу на другом устройстве.'), 401);

async function learner(request, response, path, isPost, identity, search) {
  const studentId = identity?.split('~', 1)[0];
  const student = studentId && data.student(studentId);
  const valid = () => student && studentIdentity(data.student(studentId)) === identity;
  if (!valid()) return isPost ? json(response, { state: 'login' }, 401) : inviteRequired(response);
  if (path === '/learn' && !isPost) {
    const wanted = search.get('work');
    if (wanted && data.get(wanted)?.student_id === student.id) return redirect(response, '/learn/' + wanted);
    return html(response, ui.today(student, data.works(student.id)));
  }
  const match = learnPattern.exec(path);
  if (!match) return notFound(response);
  const [, workId, action] = match;
  const work = data.get(workId);
  if (!work || work.student_id !== student.id) return isPost ? json(response, { state: 'missing' }, 404) : notFound(response);
  if (!action && !isPost) {
    data.opened(workId);
    response.setHeader('Content-Security-Policy', notebookPolicy);
    return html(response, notebookPage(work.grade, {
      work: work.id, name: student.name, revision: work.revision, state: work.state, submitted: Boolean(work.submitted_at),
    }));
  }
  if (!isPost || !action) return notFound(response);
  const form = await formBody(request, 400000);
  const revision = Number(form.get('revision'));
  if (!Number.isSafeInteger(revision)) throw new RequestError(400, 'Обнови страницу.');
  if (action === 'save') {
    const state = form.get('state') ?? '';
    const report = (form.get('report') ?? '').slice(0, 100000);
    if (state) {
      try {
        if (typeof JSON.parse(state) !== 'object') throw new Error();
      } catch {
        throw new RequestError(400, 'Ответы не распознаны.');
      }
    }
    if (state.length > 250000) throw new RequestError(413, 'Слишком много данных.');
    const saved = data.save(workId, revision, state, report);
    return json(response, saved, saved.state ? 409 : 200);
  }
  const submitted = data.submit(workId, revision);
  return json(response, submitted, submitted.state === 'submitted' ? 200 : 409);
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', cabinetPolicy);
  try {
    const { pathname: path, searchParams: search } = new URL(request.url, 'http://localhost');
    const isPost = request.method === 'POST';
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new RequestError(405, 'Этот способ запроса недоступен.');
    if (isPost && (request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && request.headers.origin !== origin(request)))) {
      throw new RequestError(403, 'Открой страницу напрямую и повтори действие.');
    }
    const asset = assets.get(path);
    if (asset && !isPost) return response.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-cache' }).end(asset[1]);
    const jar = cookies(request);
    if (path === '/' && !isPost) return redirect(response, '/tutor');
    if (path === '/tutor' || path.startsWith('/tutor/')) {
      const loggedIn = equal(sessionId('tutor', jar.get('marker_tutor')), tutorId);
      return await tutor(request, response, path, search, isPost, loggedIn);
    }
    const invite = !isPost && invitePattern.exec(path);
    if (invite) {
      const [, studentId, workId, token] = invite;
      const student = data.student(studentId);
      if (!student || !equal(token, inviteToken(student, workId))) return notFound(response);
      if (workId && data.get(workId)?.student_id !== studentId) return notFound(response);
      response.setHeader('Referrer-Policy', 'no-referrer');
      const cookie = makeCookie('marker_student', session('student', studentIdentity(student), DAY * 180), DAY * 180);
      return redirect(response, workId ? '/learn/' + workId : '/learn', cookie);
    }
    if (path === '/learn' || path.startsWith('/learn/')) {
      return await learner(request, response, path, isPost, sessionId('student', jar.get('marker_student')), search);
    }
    return notFound(response);
  } catch (error) {
    const wantsJson = (request.headers.accept ?? '').includes('application/json');
    if (error instanceof RequestError) {
      return wantsJson ? json(response, { state: 'error', message: error.message }, error.status)
        : html(response, ui.message('Не удалось выполнить действие', error.message), error.status);
    }
    console.error(error);
    return html(response, ui.message('Страница временно недоступна', 'Попробуй обновить страницу через минуту.'), 500);
  }
});
server.listen(port, host, () => {
  console.log(`Тетради · кабинет · ${publicUrl?.origin || 'http://' + host + ':' + server.address().port}`);
  if (demo) console.log('Код учителя для локальной демонстрации: ' + tutorCode);
});
