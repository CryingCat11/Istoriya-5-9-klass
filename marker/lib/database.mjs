import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, link_version INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), grade INTEGER NOT NULL,
      note TEXT NOT NULL, created_at TEXT NOT NULL, opened_at TEXT, updated_at TEXT, submitted_at TEXT,
      state TEXT NOT NULL DEFAULT '', report TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS works_student ON works(student_id, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('session_key', ?)").run(randomBytes(32).toString('hex'));
  return db;
}

export function dataAccess(db) {
  const q = sql => db.prepare(sql);
  const student = q('SELECT * FROM students WHERE id = ?');
  const allStudents = q('SELECT * FROM students ORDER BY name, id');
  const addStudent = q('INSERT INTO students (id, name) VALUES (?, ?)');
  const rotateLink = q('UPDATE students SET link_version = link_version + 1 WHERE id = ? AND link_version = ?');
  const addWork = q('INSERT INTO works (id, student_id, grade, note, created_at) VALUES (?, ?, ?, ?, ?)');
  const getWork = q('SELECT works.*, students.name FROM works JOIN students ON students.id = student_id WHERE works.id = ?');
  const order = 'ORDER BY submitted_at IS NOT NULL, COALESCE(updated_at, created_at) DESC, works.id';
  const recent = q(`SELECT works.*, students.name FROM works JOIN students ON students.id = student_id ${order}`);
  const ofStudent = q(`SELECT works.*, students.name FROM works JOIN students ON students.id = student_id WHERE student_id = ? ${order}`);
  const opened = q('UPDATE works SET opened_at = ? WHERE id = ? AND opened_at IS NULL');
  const save = q('UPDATE works SET state = ?, report = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND submitted_at IS NULL');
  const submit = q('UPDATE works SET submitted_at = ? WHERE id = ? AND revision = ? AND submitted_at IS NULL');
  const reopen = q('UPDATE works SET submitted_at = NULL WHERE id = ?');
  const dropWorks = q('DELETE FROM works WHERE student_id = ?');
  const dropStudent = q('DELETE FROM students WHERE id = ?');

  const now = () => new Date().toISOString();
  function outcome(id) {
    const work = getWork.get(id);
    if (!work) return { state: 'missing' };
    return work.submitted_at ? { state: 'submitted', revision: work.revision } : { state: 'conflict', revision: work.revision };
  }

  return {
    key: q("SELECT value FROM settings WHERE name = 'session_key'").get().value,
    student: id => student.get(id),
    students: () => allStudents.all(),
    addStudent(name) {
      const id = randomUUID();
      addStudent.run(id, name);
      return id;
    },
    rotateLink: (id, version) => rotateLink.run(id, version),
    create(studentId, grade, note) {
      const id = randomUUID();
      addWork.run(id, studentId, grade, note, now());
      return id;
    },
    get: id => getWork.get(id),
    works: id => (id ? ofStudent.all(id) : recent.all()),
    opened: id => opened.run(now(), id),
    save(id, revision, state, report) {
      if (save.run(state, report, now(), id, revision).changes) return { revision: revision + 1 };
      return outcome(id);
    },
    submit(id, revision) {
      if (submit.run(now(), id, revision).changes) return { state: 'submitted', revision };
      return outcome(id);
    },
    reopen: id => reopen.run(id),
    removeStudent(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        dropWorks.run(id);
        dropStudent.run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
