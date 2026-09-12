import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../server/config';
import { createApp } from '../server/app';
import { prepareInput, type AIProvider } from '../server/ai';
const header = { 'x-lumori-request': '1' };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const fakeAI: AIProvider = {
  async status() {
    return {
      ready: true,
      models: [
        { id: 'gpt-5.6-sol', name: 'Sol', description: 'Codex', effort: 'low', default: true },
      ],
    };
  },
  async *stream() {
    yield {
      type: 'activity',
      activity: { id: 'tool1', label: 'Команда', detail: 'pwd', status: 'complete' },
    };
    yield { type: 'delta', text: 'Привет!\n\n```ts\nconst x=42;\n```' };
    yield { type: 'usage', tokens: 42 };
  },
};
function setup(provider: AIProvider = fakeAI) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'luma-test-'));
  const config = {
    ...getConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, 'workspaces'),
    password: 'test-password-only',
    karinaPassword: 'karina-test-password',
    secret: 'x'.repeat(40),
    configured: true,
    origin: '',
    speechPython: '',
    speechModel: '',
  };
  const instance = createApp(config, provider);
  cleanup.push(() => {
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...instance, config, agent: request.agent(instance.app) };
}
async function login(agent: ReturnType<typeof request.agent>) {
  return agent.post('/api/login').set(header).send({ password: 'test-password-only' }).expect(200);
}
async function newChat(agent: ReturnType<typeof request.agent>) {
  return (await agent.post('/api/chats').set(header).send({ model: 'gpt-5.6-sol' }).expect(201))
    .body;
}
describe('Codex workspace routes', () => {
  it('saves study mode and accepts switching back to everyday conversation', async () => {
    const { agent } = setup();
    await login(agent);
    const created = await agent.post('/api/chats').set(header).send({ model: 'gpt-5.6-sol', mode: 'study' }).expect(201);
    expect((await agent.get(`/api/chats/${created.body.id}`).expect(200)).body.mode).toBe('study');
    expect((await agent.patch(`/api/chats/${created.body.id}`).set(header).send({mode:'auto'}).expect(200)).body.mode).toBe('auto');
  });
  it('does not expose internal Codex error details to the browser', async () => {
    const { agent } = setup({ ...fakeAI, async *stream() { throw new Error('Codex: private-internal-diagnostic'); } });
    await login(agent);
    const chat = await newChat(agent);
    const response = await agent.post(`/api/chats/${chat.id}/messages`).set(header).send({text:'test', attachmentIds:[]}).expect(200);
    expect(response.text).not.toContain('private-internal-diagnostic');
    expect(response.text).toContain('Не удалось выполнить запрос');
  });
  it('protects files and conversations, rejects cross-site mutations and revokes login', async () => {
    const { agent } = setup();
    const anonymous = (await agent.get('/api/session').expect(200)).body;
    expect(anonymous.authenticated).toBe(false);
    expect(anonymous.models).toEqual([]);
    expect(anonymous.codexReady).toBe(false);
    expect((await agent.get('/robots.txt').expect(200)).text).toContain('Disallow: /');
    await agent.get('/api/chats').expect(401);
    await agent.get('/api/files/random').expect(401);
    await agent
      .post('/api/login')
      .set(header)
      .set('Origin', 'https://evil.example')
      .send({ password: 'test-password-only' })
      .expect(403);
    await agent.post('/api/login').send({ password: 'test-password-only' }).expect(403);
    await agent.post('/api/login').set(header).send({ password: 'wrong' }).expect(401);
    await login(agent);
    await agent.get('/api/chats').expect(200);
    await agent.post('/api/logout').set(header).expect(200);
    await agent.get('/api/chats').expect(401);
  });
  it('reads models from Codex, streams actions, saves history, retries, and removes files', async () => {
    const { agent, store, config } = setup();
    await login(agent);
    const session = (await agent.get('/api/session')).body;
    expect(session.codexReady).toBe(true);
    expect(session.models).toEqual(['gpt-5.6-sol']);
    expect(session.apiReady).toBeUndefined();
    const file = (
      await agent
        .post('/api/files')
        .set(header)
        .attach('file', Buffer.from('const answer=42;'), 'hello.ts')
        .expect(201)
    ).body;
    const chat = await newChat(agent);
    const response = await agent
      .post(`/api/chats/${chat.id}/messages`)
      .set(header)
      .send({ text: 'Explain', attachmentIds: [file.id] })
      .expect(200);
    expect(response.text).toContain('"type":"activity"');
    expect(response.text).toContain('"type":"done"');
    const saved = store.get(chat.id)!;
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1].tokens).toBe(42);
    expect(saved.messages[1].activities?.[0].detail).toBe('pwd');
    const input = prepareInput(saved, store, config, true);
    expect(JSON.stringify(input.input)).toContain('hello.ts');
    expect(
      readFileSync(path.join(input.cwd, 'attachments', `${file.id}-hello.ts`), 'utf8'),
    ).toContain('answer=42');
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .set(header)
      .send({ retry: true })
      .expect(200);
    expect(store.get(chat.id)?.messages).toHaveLength(2);
    await agent
      .patch(`/api/chats/${chat.id}`)
      .set(header)
      .send({ title: 'Codex files' })
      .expect(200);
    await agent.delete(`/api/chats/${chat.id}`).set(header).expect(200);
    await agent.get(`/api/files/${file.id}`).expect(404);
  });
  it('validates binary signatures, sizes, unknown models and missing attachments', async () => {
    const { agent } = setup();
    await login(agent);
    await agent
      .post('/api/files')
      .set(header)
      .attach('file', Buffer.from('not image'), 'fake.png')
      .expect(400);
    await agent
      .post('/api/files')
      .set(header)
      .attach('file', Buffer.from('<svg/>'), 'file.svg')
      .expect(400);
    await agent
      .post('/api/files')
      .set(header)
      .attach('file', Buffer.alloc(150001, 'a'), 'big.txt')
      .expect(413);
    await agent.post('/api/chats').set(header).send({ model: 'fake' }).expect(400);
    const chat = await newChat(agent);
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .set(header)
      .send({ text: 'x', attachmentIds: [randomUUID()] })
      .expect(400);
    await agent.post(`/api/chats/${chat.id}/messages`).set(header).send({ text: '' }).expect(400);
  });
  it('accepts verified Office packages and keeps temporary chats out of history', async () => {
    const { agent } = setup();
    await login(agent);
    const xlsx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('[Content_Types].xml xl/worksheets/sheet1.xml'),
    ]);
    expect(
      (
        await agent.post('/api/files').set(header).attach('file', xlsx, 'budget.xlsx').expect(201)
      ).body.mime,
    ).toContain('spreadsheetml');
    await agent
      .post('/api/files')
      .set(header)
      .attach('file', Buffer.from('not an Office document'), 'budget.xlsx')
      .expect(400);
    const temporary = (
      await agent
        .post('/api/chats')
        .set(header)
        .send({ model: 'gpt-5.6-sol', temporary: true })
        .expect(201)
    ).body;
    expect(temporary.temporary).toBe(true);
    expect((await agent.get('/api/chats')).body).toEqual([]);
    await agent.get(`/api/chats/${temporary.id}`).expect(200);
  });
  it('reports a disconnected Codex without fabricating messages', async () => {
    const { agent, store } = setup({
      ...fakeAI,
      async status() {
        return { ...(await fakeAI.status()), ready: false, error: 'Codex не подключён.' };
      },
    });
    await login(agent);
    const chat = await newChat(agent);
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .set(header)
      .send({ text: 'hello' })
      .expect(503);
    expect(store.get(chat.id)?.messages).toHaveLength(0);
  });
  it('preserves partial answers on provider failure without exposing internal errors', async () => {
    const { agent, store } = setup({
      ...fakeAI,
      async *stream() {
        yield { type: 'delta', text: 'Partial' };
        throw new Error('Internal secret');
      },
    });
    await login(agent);
    const chat = await newChat(agent);
    const response = await agent
      .post(`/api/chats/${chat.id}/messages`)
      .set(header)
      .send({ text: 'hello' });
    expect(response.text).not.toContain('Internal secret');
    expect(store.get(chat.id)?.messages.at(-1)?.status).toBe('error');
  });
  it('only downloads regular workspace files, rejecting traversal and symlinks', async () => {
    const { agent, config } = setup();
    await login(agent);
    const chat = await newChat(agent);
    const root = path.join(config.workspaceDir, chat.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'result.txt'), 'Codex result');
    symlinkSync('/etc/passwd', path.join(root, 'escape.txt'));
    expect(
      (await agent.get(`/api/chats/${chat.id}/artifacts`)).body.map(
        (f: { path: string }) => f.path,
      ),
    ).toEqual(['result.txt']);
    expect(
      (await agent.get(`/api/chats/${chat.id}/artifact`).query({ path: 'result.txt' })).text,
    ).toBe('Codex result');
    await agent
      .get(`/api/chats/${chat.id}/artifact`)
      .query({ path: '../../etc/passwd' })
      .expect(404);
    await agent.get(`/api/chats/${chat.id}/artifact`).query({ path: 'escape.txt' }).expect(404);
  });
  it('cancels generation and rejects concurrent mutations', async () => {
    const { app, agent, store } = setup({
      ...fakeAI,
      async *stream(_chat, signal) {
        yield { type: 'delta', text: 'Начало' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const auth = await login(agent);
    const cookie = auth.headers['set-cookie'][0].split(';')[0];
    const chat = await newChat(agent);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/chats/${chat.id}/messages`, {
        method: 'POST',
        headers: { ...header, cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Start' }),
      });
      const reader = response.body!.getReader();
      await reader.read();
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .set(header)
        .send({ text: 'Duplicate' })
        .expect(409);
      await agent.delete(`/api/chats/${chat.id}`).set(header).expect(409);
      await agent.patch(`/api/chats/${chat.id}`).set(header).send({ title: 'race' }).expect(409);
      await agent.post(`/api/chats/${chat.id}/stop`).set(header).expect(200);
      while (!(await reader.read()).done) {}
      expect(store.get(chat.id)?.messages.at(-1)?.status).toBe('stopped');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it('sends images as localImage and preserves native thread bindings in SQLite', async () => {
    const { agent, config, store } = setup();
    await login(agent);
    const chat = await newChat(agent);
    const file = {
      id: randomUUID(),
      name: 'photo.png',
      mime: 'image/png',
      size: 10,
      createdAt: Date.now(),
    };
    store.addFile(file);
    writeFileSync(path.join(config.dataDir, 'uploads', file.id), 'image');
    chat.messages = [
      {
        id: randomUUID(),
        role: 'user',
        text: 'Describe',
        attachments: [file],
        status: 'complete',
        createdAt: Date.now(),
      },
    ];
    store.save(chat);
    store.bindThread(chat.id, 'native-thread-1');
    expect(store.thread(chat.id)).toBe('native-thread-1');
    const input = prepareInput(chat, store, config, false);
    expect(input.input[1].type).toBe('localImage');
  });
  it('validates audio and clearly reports unconfigured local speech', async () => {
    const { agent } = setup();
    await login(agent);
    await agent
      .post('/api/transcribe')
      .set(header)
      .attach('file', Buffer.from('data'), { filename: 'bad.txt', contentType: 'text/plain' })
      .expect(400);
    const response = await agent
      .post('/api/transcribe')
      .set(header)
      .attach('file', Buffer.from('data'), { filename: 'voice.webm', contentType: 'audio/webm' })
      .expect(500);
    expect(response.body.error).toContain('Локальное распознавание');
  });
});

describe('separate accounts', () => {
  it('isolates lists, mutations, files, artifacts, cancellation and attachment references in both directions', async () => {
    const { app, agent: owner, store } = setup();
    const karina = request.agent(app);
    await login(owner);
    await karina
      .post('/api/login')
      .set(header)
      .send({ username: 'karina', password: 'test-password-only' })
      .expect(401);
    await karina
      .post('/api/login')
      .set(header)
      .send({ username: 'karina', password: 'karina-test-password' })
      .expect(200);
    expect((await karina.get('/api/session')).body.user).toEqual({ id: 'karina', name: 'Карина' });
    const a = await newChat(owner);
    const b = await newChat(karina);
    for (const [self, other, chat] of [
      [owner, karina, a],
      [karina, owner, b],
    ] as const) {
      expect((await self.get('/api/chats')).body.map((c: { id: string }) => c.id)).toEqual([
        chat.id,
      ]);
      const file = (
        await self
          .post('/api/files')
          .set(header)
          .attach('file', Buffer.from('private'), 'note.txt')
          .expect(201)
      ).body;
      await other.get(`/api/files/${file.id}`).expect(404);
      await self.get(`/api/files/${file.id}`).expect(200);
      await other.get(`/api/chats/${chat.id}`).expect(404);
      await other.get(`/api/chats/${chat.id}/artifacts`).expect(404);
      await other.get(`/api/chats/${chat.id}/artifact?path=secret.txt`).expect(404);
      await other.patch(`/api/chats/${chat.id}`).set(header).send({ title: 'stolen' }).expect(404);
      await other.post(`/api/chats/${chat.id}/stop`).set(header).expect(404);
      await other
        .post(`/api/chats/${chat.id}/messages`)
        .set(header)
        .send({ text: 'hello' })
        .expect(404);
      await other.delete(`/api/chats/${chat.id}`).set(header).expect(404);
      const ownOther = chat.id === a.id ? b : a;
      await other
        .post(`/api/chats/${ownOther.id}/messages`)
        .set(header)
        .send({ attachmentIds: [file.id] })
        .expect(400);
      await self
        .post(`/api/chats/${chat.id}/messages`)
        .set(header)
        .send({ text: 'hello', attachmentIds: [file.id] })
        .expect(200);
      expect(store.ownsChat(chat.id, chat.id === a.id ? 'owner' : 'karina')).toBe(true);
    }
    await karina.post('/api/logout').set(header).expect(200);
    await karina.get('/api/chats').expect(401);
    await owner.get(`/api/chats/${a.id}`).expect(200);
  });
});

it('migrates existing chats, files and signed sessions to the owner account', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'luma-migration-'));
  const db = new DatabaseSync(path.join(dir, 'luma.db'));
  db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY,title TEXT,model TEXT,mode TEXT,updatedAt INTEGER,messages TEXT);
    CREATE TABLE files (id TEXT PRIMARY KEY,name TEXT,mime TEXT,size INTEGER,createdAt INTEGER);
    CREATE TABLE sessions (token TEXT PRIMARY KEY,expires INTEGER);`);
  const id = randomUUID();
  db.prepare('INSERT INTO chats VALUES (?,?,?,?,?,?)').run(
    id,
    'Existing history',
    'gpt-5.6-sol',
    'auto',
    Date.now(),
    '[]',
  );
  db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run(
    'existing-file',
    'note.txt',
    'text/plain',
    1,
    Date.now(),
  );
  const token = 'existing-session';
  db.prepare('INSERT INTO sessions VALUES (?,?)').run(
    createHash('sha256').update(token).digest('hex'),
    Date.now() + 60000,
  );
  db.close();
  const config = {
    ...getConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, 'workspaces'),
    password: 'test-password-only',
    karinaPassword: 'karina-test-password',
    secret: 'x'.repeat(40),
    configured: true,
    secure: false,
    origin: '',
  };
  const instance = createApp(config, fakeAI);
  cleanup.push(() => {
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const signature = createHmac('sha256', config.secret + config.password)
    .update(token)
    .digest('hex');
  const response = await request(instance.app)
    .get('/api/chats')
    .set('Cookie', `lumori_session=${token}.${signature}`)
    .expect(200);
  expect(response.body.map((c: { id: string }) => c.id)).toEqual([id]);
  expect(instance.store.ownsFile('existing-file', 'owner')).toBe(true);
  const karina = request.agent(instance.app);
  await karina
    .post('/api/login')
    .set(header)
    .send({ username: 'karina', password: 'karina-test-password' })
    .expect(200);
  expect((await karina.get('/api/chats')).body).toEqual([]);
});

it('keeps account quota behind authentication and returns provider values', async () => {
  const sample = {
    available: true,
    updatedAt: 123,
    buckets: [
      {
        id: 'codex',
        name: 'Codex',
        windows: [{ id: 'primary', usedPercent: 71, durationMinutes: 300, resetsAt: null }],
      },
    ],
  };
  const { agent } = setup({
    ...fakeAI,
    async limits() {
      return sample;
    },
  });
  await agent.get('/api/limits').expect(401);
  await login(agent);
  expect((await agent.get('/api/limits').expect(200)).body).toEqual(sample);
});
it('reports unsupported quota without fake remaining percentages', async () => {
  const { agent } = setup();
  await login(agent);
  const response = await agent.get('/api/limits').expect(200);
  expect(response.body.available).toBe(false);
  expect(response.body.buckets).toEqual([]);
});
