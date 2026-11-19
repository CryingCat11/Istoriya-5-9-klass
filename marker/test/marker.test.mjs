import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const code = 'test-code-for-the-tutor-cabinet-1234';
const db = join(mkdtempSync(join(tmpdir(), 'marker-test-')), 'notebooks.sqlite');

async function start(port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), MARKER_TUTOR_CODE: code, MARKER_DB: db },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(resolve => child.stdout.once('data', resolve));
  return child;
}

function client(origin) {
  const jar = new Map();
  return async function request(path, { form, json } = {}) {
    const headers = { Origin: origin };
    if (jar.size) headers.Cookie = [...jar].map(([key, value]) => key + '=' + value).join('; ');
    if (json) headers.Accept = 'application/json';
    const init = { headers, redirect: 'manual' };
    if (form) {
      init.method = 'POST';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form);
    }
    const response = await fetch(new URL(path, origin), init);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
}

test('учитель выдаёт тетрадь, ученик пишет и сдаёт, ответы видны учителю и переживают перезапуск', async () => {
  const port = 4900 + Math.floor(Math.random() * 500);
  const origin = 'http://127.0.0.1:' + port;
  let server = await start(port);
  try {
    const tutor = client(origin);
    assert.equal((await tutor('/tutor/login', { form: { code: 'wrong-code' } })).status, 401);
    assert.equal((await tutor('/tutor/login', { form: { code } })).status, 303);
    const added = await tutor('/tutor/students', { form: { name: 'Алина К.' } });
    const studentPath = added.headers.get('location');
    assert.match(studentPath, /^\/tutor\/students\//);
    const created = await tutor('/tutor/new', { form: { student: studentPath.split('/').pop(), grade: '9', note: 'Начни с разведки' } });
    const workPath = created.headers.get('location').split('?')[0];
    const workId = workPath.split('/').pop();
    const page = await (await tutor(workPath)).text();
    const link = page.match(/value="(http[^"]+\/s\/[^"]+)"/)[1];
    assert.ok(link.includes(workId));

    const student = client(origin);
    assert.equal((await student('/learn/' + workId)).status, 401);
    const opened = await student(new URL(link).pathname);
    assert.equal(opened.headers.get('location'), '/learn/' + workId);
    const notebook = await (await student('/learn/' + workId)).text();
    assert.match(notebook, /window\.MARKER=\{"work":"/);
    assert.match(notebook, /Кадры одного века/);

    const state = JSON.stringify({ 'tm-know': 'Крымская война' });
    let saved = await student(`/learn/${workId}/save`, { json: true, form: { revision: '0', state, report: 'ЗНАКОМСТВО: Крымская война' } });
    assert.deepEqual(await saved.json(), { revision: 1 });
    saved = await student(`/learn/${workId}/save`, { json: true, form: { revision: '0', state, report: '' } });
    assert.equal(saved.status, 409);

    let live = await (await tutor(workPath + '.json')).json();
    assert.equal(live.code, 'live');
    assert.match(live.html, /<b>ЗНАКОМСТВО<\/b> Крымская война/);

    const outsider = client(origin);
    assert.equal((await outsider(workPath + '.json')).status, 401);

    assert.equal((await student(`/learn/${workId}/submit`, { json: true, form: { revision: '1' } })).status, 200);
    saved = await student(`/learn/${workId}/save`, { json: true, form: { revision: '1', state: '{}', report: '' } });
    assert.equal((await saved.json()).state, 'submitted');

    const extra = await tutor('/tutor/students', { form: { name: 'Тимур С.' } });
    const extraPath = extra.headers.get('location');
    const extraWork = await tutor('/tutor/new', { form: { student: extraPath.split('/').pop(), grade: '5', note: '' } });
    const extraWorkPath = extraWork.headers.get('location').split('?')[0];
    assert.match(await (await tutor(extraPath + '/delete')).text(), /Тимур С\.[\s\S]*Удалить ученика\?/);
    assert.equal((await tutor(extraPath + '/delete', { form: {} })).headers.get('location'), '/tutor/students?removed=1');
    assert.equal((await tutor(extraPath)).status, 404);
    assert.equal((await tutor(extraWorkPath)).status, 404);
    assert.equal((await outsider(extraPath + '/delete', { form: {} })).status, 303);
    assert.equal((await tutor(studentPath)).status, 200);

    server.kill();
    server = await start(port);
    live = await (await tutor(workPath + '.json')).json();
    assert.equal(live.submitted, true);
    assert.match(live.html, /Крымская война/);
    const again = await (await student('/learn/' + workId)).text();
    assert.match(again, /"submitted":true/);
    assert.match(again, /tm-know/);
  } finally {
    server.kill();
  }
});
