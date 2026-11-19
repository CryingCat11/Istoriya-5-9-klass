import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

export const notebooks = [
  { grade: 5, file: '5-klass.html', title: 'Тайна иероглифов', key: 'ieroglify-v1' },
  { grade: 6, file: '6-klass.html', title: 'Письма из-под земли', key: 'bereste6-v2' },
  { grade: 7, file: '7-klass.html', title: 'Тайна первопечатника', key: 'pervopechat7-v1' },
  { grade: 8, file: '8-klass.html', title: 'Который год?', key: 'kalendar8-v1' },
  { grade: 9, file: '9-klass.html', title: 'Кадры одного века', key: 'foto9-v1' },
];
export const byGrade = new Map(notebooks.map(item => [item.grade, item]));

// Тетрадь читается при каждом открытии, поэтому правки в репозитории видны без перезапуска
export function notebookPage(grade, config) {
  const notebook = byGrade.get(grade);
  const source = readFileSync(new URL(notebook.file, root), 'utf8');
  const data = JSON.stringify({ ...config, key: notebook.key, grade }).replace(/</g, '\\u003c');
  const inject = `<script>window.MARKER=${data};</script><script src="/assets/sync.js"></script>` +
    '<link rel="stylesheet" href="/assets/sync.css">';
  return source.replace(/<head>/i, match => match + inject);
}

// Открытая демоверсия: главная и тетради как на сайте, ответы остаются только в браузере
export const publicPages = new Map([['/', 'index.html'], ['/index.html', 'index.html'],
  ...notebooks.map(item => ['/' + item.file, item.file])]);
export const publicPage = file => readFileSync(new URL(file, root), 'utf8');
