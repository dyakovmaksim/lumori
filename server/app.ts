import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { createStore } from './store.js';
import { createAI, workspaceFor, type AIProvider } from './ai.js';
import { transcribe } from './speech.js';
import { listArtifacts, resolveArtifact } from './artifacts.js';
import type { Chat, Message } from '../shared/types.js';
import { registerTerminal } from './terminal.js';
const hash = (value: string) => createHash('sha256').update(value).digest();
const mode = z.enum(['auto', 'code', 'write', 'analyze', 'study']);
export function createApp(config: Config, suppliedAI?: AIProvider) {
  const app = express();
  const store = createStore(config.dataDir);
  const ai = suppliedAI || createAI(config, store);
  const active = new Map<string, AbortController>();
  // Recover interrupted responses after a process restart.
  for (const summary of store.list()) {
    const chat = store.get(summary.id)!;
    if (chat.messages.some((m) => m.status === 'streaming')) {
      chat.messages.forEach((m) => {
        if (m.status === 'streaming') m.status = 'stopped';
      });
      store.save(chat);
    }
  }
  function cleanupFiles() {
    const used = new Set(
      store
        .list()
        .flatMap((c) => store.get(c.id)!.messages.flatMap((m) => m.attachments.map((a) => a.id))),
    );
    for (const file of store.files())
      if (!used.has(file.id) && file.createdAt < Date.now() - 86400000) {
        try {
          unlinkSync(path.join(config.dataDir, 'uploads', file.id));
        } catch {
          /* Already removed. */
        }
        store.removeFile(file.id);
      }
  }
  cleanupFiles();
  const temporaryTtl = 24 * 60 * 60_000;
  const purgeTemporaryChats = async () => {
    for (const summary of store.list()) {
      const chat = store.get(summary.id);
      if (!chat?.temporary || chat.updatedAt > Date.now() - temporaryTtl || active.has(chat.id)) continue;
      try {
        await ai.archive?.(chat.id);
      } catch {
        // Local data can still be removed; the native session will expire separately.
      }
      rmSync(workspaceFor(config, chat.id), { recursive: true, force: true });
      store.remove(chat.id);
    }
    cleanupFiles();
  };
  void purgeTemporaryChats();
  const maintenanceTimer = setInterval(() => void purgeTemporaryChats(), 60 * 60_000);
  maintenanceTimer.unref();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  // This is a private workspace, never a public search result.
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:'],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // A custom header plus same-origin checks prevent cross-site form/fetch mutations.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const expected = config.origin || `${req.protocol}://${req.get('host')}`;
    if (req.get('x-lumori-request') !== '1' || (req.get('origin') && req.get('origin') !== expected))
      return res.status(403).json({ error: 'Запрос с другого сайта отклонён.' });
    next();
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.secure,
    path: '/',
    maxAge: 7 * 86400000,
  };
  const accounts = [
    { id: 'owner', name: 'Моё пространство', password: config.password },
    ...(config.karinaPassword.length >= 12
      ? [{ id: 'karina', name: 'Карина', password: config.karinaPassword }]
      : []),
  ];
  function token(req: Request) {
    const value = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('lumori_session='))
      ?.slice('lumori_session='.length);
    if (!value || !config.configured) return '';
    const [id, signature] = value.split('.');
    const session = store.db
      .prepare('SELECT expires,ownerId FROM sessions WHERE token = ?')
      .get(hash(id || '').toString('hex')) as { expires: number; ownerId: string } | undefined;
    const account = accounts.find((a) => a.id === session?.ownerId);
    if (!account || !session || session.expires <= Date.now()) return '';
    const valid = createHmac('sha256', config.secret + account.password)
      .update(id || '')
      .digest('hex');
    if (!signature || !timingSafeEqual(hash(signature), hash(valid))) return '';
    return id;
  }
  function user(req: Request) {
    const id = token(req);
    if (!id) return undefined;
    const session = store.db
      .prepare('SELECT ownerId FROM sessions WHERE token=?')
      .get(hash(id).toString('hex')) as { ownerId: string };
    const account = accounts.find((a) => a.id === session.ownerId)!;
    return { id: account.id, name: account.name };
  }
  app.get('/api/session', async (req, res) => {
    const account = user(req);
    // Do not expose model availability or service state before authentication.
    if (!account)
      return res.json({
        authenticated: false,
        setupRequired: !config.configured,
        codexReady: false,
        modelDetails: [],
        models: [],
      });
    const status = await ai.status();
    res.json({
      authenticated: true,
      user: account,
      setupRequired: !config.configured,
      codexReady: status.ready,
      codexError: status.error,
      models: status.models.map((m) => m.id),
      modelDetails: status.models,
    });
  });
  app.post(
    '/api/login',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Слишком много попыток. Подождите 15 минут.' },
    }),
    (req, res) => {
      if (!config.configured)
        return res.status(503).json({
          error: 'Добавьте APP_PASSWORD (от 12 символов) и SESSION_SECRET (от 32 символов) в .env.',
        });
      const body = z
        .object({
          username: z.enum(['owner', 'karina']).default('owner'),
          password: z.string().min(1).max(512),
        })
        .parse(req.body);
      const account = accounts.find((a) => a.id === body.username);
      if (
        !account ||
        !timingSafeEqual(hash(body.password), hash(account.password))
      )
        return res.status(401).json({ error: 'Неверный пароль. Попробуйте ещё раз.' });
      const id = randomBytes(32).toString('hex');
      store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      store.db
        .prepare('INSERT INTO sessions (token,expires,ownerId) VALUES (?,?,?)')
        .run(hash(id).toString('hex'), Date.now() + cookieOptions.maxAge, account.id);
      const signature = createHmac('sha256', config.secret + account.password)
        .update(id)
        .digest('hex');
      res.cookie('lumori_session', `${id}.${signature}`, cookieOptions).json({ ok: true });
    },
  );
  app.use('/api', (req, res, next) => {
    if (!token(req)) return res.status(401).json({ error: 'Войдите в своё пространство.' });
    next();
  });
  app.post('/api/logout', (req, res) => {
    terminal.closeToken(token(req));
    store.db.prepare('DELETE FROM sessions WHERE token = ?').run(hash(token(req)).toString('hex'));
      res.clearCookie('lumori_session', cookieOptions).json({ ok: true });
  });
  const terminal = registerTerminal(app, store, (req) => {
    const account = user(req);
    return account ? { id: account.id, token: token(req) } : undefined;
  });
  app.get('/api/limits', async (_req, res) => {
    res.json(
      ai.limits
        ? await ai.limits()
        : { available: false, buckets: [], error: 'Codex не передаёт данные о лимитах.' },
    );
  });
  app.get('/api/chats', (req, res) => res.json(store.list(user(req)!.id)));
  // Ownership applies to every chat endpoint, including cancellation and artifacts.
  app.use('/api/chats/:id', (req, res, next) => {
    if (!store.ownsChat(req.params.id, user(req)!.id))
      return res.status(404).json({ error: 'Диалог не найден.' });
    next();
  });
  app.post('/api/chats', async (req, res) => {
    const body = z
      .object({ model: z.string(), mode: mode.default('auto'), temporary: z.boolean().default(false) })
      .parse(req.body);
    if (!(await ai.status()).models.some((m) => m.id === body.model))
      return res.status(400).json({ error: 'Эта модель не включена в настройках сервера.' });
    const chat: Chat = {
      id: randomUUID(),
      title: 'Новый диалог',
      ...body,
      updatedAt: Date.now(),
      messages: [],
    };
    store.save(chat, user(req)!.id);
    res.status(201).json(chat);
  });
  app.get('/api/chats/:id', (req, res) => {
    const chat = store.get(req.params.id);
    res.status(chat ? 200 : 404).json(chat || { error: 'Диалог не найден.' });
  });
  app.patch('/api/chats/:id', async (req, res) => {
    const chat = store.get(String(req.params.id));
    if (!chat) return res.status(404).json({ error: 'Диалог не найден.' });
    if (active.has(chat.id)) return res.status(409).json({ error: 'Дождитесь окончания ответа.' });
    const body = z
      .object({
        title: z.string().trim().min(1).max(100).optional(),
        model: z.string().optional(),
        mode: mode.optional(),
      })
      .parse(req.body);
    if (body.model && !(await ai.status()).models.some((m) => m.id === body.model))
      return res.status(400).json({ error: 'Модель недоступна.' });
    const latest = store.get(chat.id);
    if (!latest) return res.status(404).json({ error: 'Диалог не найден.' });
    if (active.has(chat.id)) return res.status(409).json({ error: 'Дождитесь окончания ответа.' });
    Object.assign(latest, body);
    store.save(latest, user(req)!.id);
    res.json(latest);
  });
  app.delete('/api/chats/:id', async (req, res) => {
    if (active.has(req.params.id))
      return res.status(409).json({ error: 'Сначала остановите ответ.' });
    const chat = store.get(req.params.id);
    if (chat) {
      active.set(chat.id, new AbortController());
      try {
        await ai.archive?.(chat.id);
        rmSync(workspaceFor(config, chat.id), { recursive: true, force: true });
      } finally {
        active.delete(chat.id);
      }
    }
    store.remove(req.params.id);
    const used = new Set(
      store
        .list()
        .flatMap((c) => store.get(c.id)!.messages.flatMap((m) => m.attachments.map((a) => a.id))),
    );
    for (const id of new Set(chat?.messages.flatMap((m) => m.attachments.map((a) => a.id)) || []))
      if (!used.has(id)) {
        try {
          unlinkSync(path.join(config.dataDir, 'uploads', id));
        } catch {
          /* Already removed. */
        }
        store.removeFile(id);
      }
    res.json({ ok: true });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 },
  });
  const uploadLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    message: { error: 'Слишком много загрузок. Подождите минуту.' },
  });
  app.post('/api/files', uploadLimit, upload.single('file'), (req, res) => {
    cleanupFiles();
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Выберите файл.' });
    if (store.usedBytes() + file.size > config.maxStorage)
      return res.status(413).json({ error: 'Хранилище заполнено. Удалите ненужные диалоги.' });
    const name = Buffer.from(file.originalname, 'latin1')
      .toString('utf8')
      .replace(/[\x00-\x1f/\\]/g, '_')
      .slice(0, 180);
    const ext = path.extname(name).toLowerCase();
    let mime = '';
    const b = file.buffer;
    const zipPackage = (marker: string) =>
      b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      b.includes(Buffer.from('[Content_Types].xml')) &&
      b.includes(Buffer.from(marker));
    const oleDocument = b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (['.jpg', '.jpeg'].includes(ext) && b[0] === 0xff && b[1] === 0xd8) mime = 'image/jpeg';
    else if (
      ext === '.png' &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = 'image/png';
    else if (
      ext === '.webp' &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP'
    )
      mime = 'image/webp';
    else if (ext === '.pdf' && b.toString('ascii', 0, 5) === '%PDF-') mime = 'application/pdf';
    else if (['.xlsx', '.xlsm'].includes(ext) && zipPackage('xl/'))
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (ext === '.docx' && zipPackage('word/'))
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (ext === '.pptx' && zipPackage('ppt/'))
      mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    else if (
      ext === '.ods' &&
      b.includes(Buffer.from('application/vnd.oasis.opendocument.spreadsheet'))
    )
      mime = 'application/vnd.oasis.opendocument.spreadsheet';
    else if (
      ext === '.odt' &&
      b.includes(Buffer.from('application/vnd.oasis.opendocument.text'))
    )
      mime = 'application/vnd.oasis.opendocument.text';
    else if (['.xls', '.doc', '.ppt'].includes(ext) && oleDocument)
      mime = 'application/x-ole-storage';
    else if (ext === '.rtf' && b.toString('ascii', 0, 5) === '{\\rtf') mime = 'application/rtf';
    else if (
      [
        '.txt',
        '.md',
        '.csv',
        '.json',
        '.js',
        '.jsx',
        '.ts',
        '.tsx',
        '.py',
        '.html',
        '.css',
        '.xml',
        '.yaml',
        '.yml',
        '.sql',
        '.sh',
        '.go',
        '.rs',
        '.java',
        '.c',
        '.cpp',
        '.h',
        '.log',
      ].includes(ext)
    ) {
      if (file.size > 150_000)
        return res
          .status(413)
          .json({ error: 'Для текстового файла лимит 150 КБ. Разделите его на части.' });
      if (b.includes(0)) return res.status(400).json({ error: 'Нужен текстовый файл в UTF-8.' });
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        return res.status(400).json({ error: 'Сохраните текстовый файл в UTF-8.' });
      }
      mime = 'text/plain';
    }
    if (!mime)
      return res.status(400).json({
        error:
          'Поддерживаются фото, PDF, Office (Excel, Word, PowerPoint), OpenDocument и текстовые файлы.',
      });
    const attachment = { id: randomUUID(), name, mime, size: file.size, createdAt: Date.now() };
    writeFileSync(path.join(config.dataDir, 'uploads', attachment.id), b, { mode: 0o600 });
    store.addFile(attachment, user(req)!.id);
    res.status(201).json(attachment);
  });
  app.get('/api/files/:id', (req, res) => {
    if (!store.ownsFile(req.params.id, user(req)!.id))
      return res.status(404).json({ error: 'Файл не найден.' });
    const file = store.file(req.params.id);
    if (!file) return res.status(404).json({ error: 'Файл не найден.' });
    res.setHeader('Content-Type', file.mime);
    res.setHeader(
      'Content-Disposition',
      `${file.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res.sendFile(path.join(config.dataDir, 'uploads', file.id), { cacheControl: false });
  });
  const aiLimit = rateLimit({
    windowMs: 60_000,
    limit: 15,
    message: { error: 'Слишком много запросов. Подождите минуту.' },
  });
  app.post('/api/transcribe', aiLimit, upload.single('file'), async (req, res) => {
    if (
      !req.file ||
      !/^(audio\/(webm|mp4|mpeg|wav|x-wav|ogg)|video\/webm)(;.*)?$/.test(req.file.mimetype)
    )
      return res.status(400).json({ error: 'Нужна аудиозапись WebM, MP4, MP3, WAV или OGG.' });
    const language = z.enum(['auto', 'ru', 'en']).default('auto').parse(req.body.language);
    res.json({ text: await transcribe(config, req.file.buffer, language) });
  });
  app.get('/api/chats/:id/artifacts', (req, res) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'Диалог не найден.' });
    res.json(listArtifacts(workspaceFor(config, req.params.id)));
  });
  app.get('/api/chats/:id/artifact', (req, res) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'Диалог не найден.' });
    const file = resolveArtifact(workspaceFor(config, req.params.id), String(req.query.path || ''));
    if (!file) return res.status(404).json({ error: 'Файл не найден.' });
    res.download(file, path.basename(file));
  });
  app.post('/api/chats/:id/stop', (req, res) => {
    active.get(req.params.id)?.abort();
    res.json({ ok: true });
  });
  app.post('/api/chats/:id/messages', aiLimit, async (req, res) => {
    const connection = await ai.status();
    if (!connection.ready)
      return res.status(503).json({ error: connection.error || 'Codex не подключён.' });
    const chat = store.get(String(req.params.id));
    if (!chat) return res.status(404).json({ error: 'Диалог не найден.' });
    // One native thread can have only one active turn. Other chats, including
    // chats belonging to another account, use independent native threads.
    if (active.has(chat.id))
      return res
        .status(409)
        .json({ error: 'Уже идёт генерация. Дождитесь ответа или остановите его.' });
    if (!connection.models.some((m) => m.id === chat.model))
      return res.status(400).json({ error: 'Выберите доступную модель.' });
    const body = z
      .object({
        text: z.string().trim().max(32000).default(''),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]),
        retry: z.boolean().default(false),
      })
      .parse(req.body);
    if (body.retry) {
      if (!chat.messages.length)
        return res.status(400).json({ error: 'Нет сообщения для повторения.' });
      if (chat.messages.at(-1)?.role === 'assistant') chat.messages.pop();
      if (chat.messages.at(-1)?.role !== 'user')
        return res.status(400).json({ error: 'Нет сообщения для повторения.' });
    } else {
      if (!body.text && !body.attachmentIds.length)
        return res.status(400).json({ error: 'Введите сообщение или прикрепите файл.' });
      const attachments = [...new Set(body.attachmentIds)].map((id) =>
        store.ownsFile(id, user(req)!.id) ? store.file(id) : undefined,
      );
      if (attachments.some((a) => !a))
        return res.status(400).json({ error: 'Файл не найден. Загрузите его заново.' });
      if (attachments.reduce((s, a) => s + (a?.size || 0), 0) > 20 * 1024 * 1024)
        return res.status(413).json({ error: 'Общий размер вложений — не более 20 МБ.' });
      chat.messages.push({
        id: randomUUID(),
        role: 'user',
        text: body.text,
        attachments: attachments as NonNullable<(typeof attachments)[number]>[],
        status: 'complete',
        createdAt: Date.now(),
      });
      if (chat.messages.length === 1)
        chat.title = (body.text || attachments[0]?.name || 'Новый диалог').slice(0, 60);
    }
    const answer: Message = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      attachments: [],
      model: chat.model,
      status: 'streaming',
      createdAt: Date.now(),
    };
    const inputChat = structuredClone(chat);
    chat.messages.push(answer);
    chat.updatedAt = Date.now();
    store.save(chat, user(req)!.id);
    const controller = new AbortController();
    active.set(chat.id, controller);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (event: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    emit({ type: 'start', chat });
    const onClose = () => controller.abort();
    res.on('close', onClose);
    const timeout = setTimeout(() => controller.abort(), config.turnTimeout);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15_000);
    let savedAt = Date.now();
    try {
      for await (const event of ai.stream(inputChat, controller.signal)) {
        if (controller.signal.aborted) continue;
        if (event.type === 'delta') answer.text += event.text;
        if (event.type === 'usage') answer.tokens = event.tokens;
        if (event.type === 'activity') {
          answer.activities = [
            ...(answer.activities || []).filter((a) => a.id !== event.activity.id),
            event.activity,
          ].slice(-40);
        }
        emit(event);
        if (Date.now() - savedAt > 1500) {
          store.save(chat, user(req)!.id);
          savedAt = Date.now();
        }
      }
      answer.status = controller.signal.aborted ? 'stopped' : 'complete';
      if (!answer.text && answer.status === 'complete') {
        answer.status = 'error';
        emit({ type: 'error', error: 'Модель вернула пустой ответ. Попробуйте повторить.' });
      }
    } catch (error) {
      answer.status = controller.signal.aborted ? 'stopped' : 'error';
      if (!controller.signal.aborted) emit({ type: 'error', error: publicError(error) });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      res.off('close', onClose);
      active.delete(chat.id);
      store.save(chat, user(req)!.id);
      emit({ type: 'done', message: answer });
      res.end();
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Маршрут не найден.' }));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  if (existsSync(path.resolve('dist/index.html'))) {
    app.use('/assets', express.static(path.resolve('dist/assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(path.resolve('dist'), { maxAge: 0 }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: 'Проверьте формат и длину введённых данных.' });
    if (error instanceof multer.MulterError)
      return res
        .status(413)
        .json({ error: 'Максимальный размер файла — 10 МБ, по одному за загрузку.' });
    res.status(500).json({ error: publicError(error) });
  });
  return {
    app,
    store,
    close: () => {
      clearInterval(maintenanceTimer);
      for (const c of active.values()) c.abort();
      ai.close?.();
      terminal.close();
      store.db.close();
    },
  };
}
function publicError(error: unknown) {
  if (
    error instanceof Error &&
    /^[А-Яа-яЁё]/.test(error.message)
  )
    return error.message.slice(0, 1500);
  return 'Не удалось выполнить запрос. Проверьте подключение к Codex и попробуйте ещё раз.';
}
