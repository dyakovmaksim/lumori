import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Chat, ChatSummary } from '../shared/types.js';
export type StoredFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
};
export function createStore(dir: string) {
  mkdirSync(path.join(dir, 'uploads'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, 'luma.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, updatedAt INTEGER NOT NULL, messages TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, createdAt INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS codex_threads (chatId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
  if (
    !db
      .prepare('PRAGMA table_info(codex_threads)')
      .all()
      .some((column) => column.name === 'totalTokens')
  )
    db.exec('ALTER TABLE codex_threads ADD COLUMN totalTokens INTEGER NOT NULL DEFAULT 0');
  for (const table of ['chats', 'files', 'sessions']) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === 'ownerId')
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ownerId TEXT NOT NULL DEFAULT 'owner'`);
  }
  if (
    !db
      .prepare('PRAGMA table_info(chats)')
      .all()
      .some((column) => column.name === 'temporary')
  )
    db.exec('ALTER TABLE chats ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0');
  return {
    db,
    ownsChat(id: string, ownerId: string) {
      return !!db.prepare('SELECT 1 FROM chats WHERE id=? AND ownerId=?').get(id, ownerId);
    },
    ownsFile(id: string, ownerId: string) {
      return !!db.prepare('SELECT 1 FROM files WHERE id=? AND ownerId=?').get(id, ownerId);
    },
    threadTokens(chatId: string) {
      return (
        (
          db.prepare('SELECT totalTokens FROM codex_threads WHERE chatId=?').get(chatId) as
            { totalTokens: number } | undefined
        )?.totalTokens || 0
      );
    },
    setThreadTokens(chatId: string, total: number) {
      db.prepare('UPDATE codex_threads SET totalTokens=? WHERE chatId=?').run(total, chatId);
    },
    thread(chatId: string) {
      return (
        db.prepare('SELECT threadId FROM codex_threads WHERE chatId=?').get(chatId) as
          { threadId: string } | undefined
      )?.threadId;
    },
    bindThread(chatId: string, threadId: string) {
      db.prepare(
        'INSERT INTO codex_threads (chatId,threadId) VALUES (?,?) ON CONFLICT(chatId) DO UPDATE SET threadId=excluded.threadId',
      ).run(chatId, threadId);
    },
    unbindThread(chatId: string) {
      db.prepare('DELETE FROM codex_threads WHERE chatId=?').run(chatId);
    },
    list: (ownerId?: string, includeTemporary = !ownerId) =>
      db
        .prepare(
          'SELECT id,title,model,mode,temporary,updatedAt FROM chats' +
            (ownerId
              ? ` WHERE ownerId=?${includeTemporary ? '' : ' AND temporary=0'}`
              : '') +
            ' ORDER BY updatedAt DESC',
        )
        .all(...(ownerId ? [ownerId] : [])) as unknown as ChatSummary[],
    get(id: string): Chat | undefined {
      const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
        (Omit<Chat, 'messages'> & { messages: string }) | undefined;
      return row ? { ...row, messages: JSON.parse(row.messages) } : undefined;
    },
    save(chat: Chat, ownerId = 'owner') {
      db.prepare(
        'INSERT INTO chats (id,title,model,mode,temporary,updatedAt,messages,ownerId) VALUES (@id,@title,@model,@mode,@temporary,@updatedAt,@messages,@ownerId) ON CONFLICT(id) DO UPDATE SET title=excluded.title,model=excluded.model,mode=excluded.mode,temporary=excluded.temporary,updatedAt=excluded.updatedAt,messages=excluded.messages',
      ).run({ ...chat, ownerId, temporary: chat.temporary ? 1 : 0, messages: JSON.stringify(chat.messages) });
    },
    remove(id: string) {
      db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    },
    file(id: string) {
      return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as StoredFile | undefined;
    },
    files: () => db.prepare('SELECT * FROM files').all() as StoredFile[],
    addFile(file: StoredFile, ownerId = 'owner') {
      db.prepare(
        'INSERT INTO files (id,name,mime,size,createdAt,ownerId) VALUES (@id,@name,@mime,@size,@createdAt,@ownerId)',
      ).run({ ...file, ownerId });
    },
    removeFile(id: string) {
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
    },
    usedBytes: () =>
      (db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM files').get() as { total: number })
        .total,
  };
}
export type Store = ReturnType<typeof createStore>;
