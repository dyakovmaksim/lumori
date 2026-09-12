import type { Express, Request, Response } from 'express';
import ssh2, { type Client, type ClientChannel } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Store } from './store.js';

type Identity = { id: string; token: string };
type Event = { type: string; [key: string]: unknown };
type Connection = {
  id: string;
  identity: Identity;
  client: Client;
  channel?: ClientChannel;
  response?: Response;
  queued: string[];
  queuedBytes: number;
  ended: boolean;
  createdAt: number;
  detachTimer?: NodeJS.Timeout;
  fingerprint?: string;
  verify?: (accepted: boolean) => void;
  host: string;
  port: number;
};

/** Authenticated SSH client only: no local shell, forwarding, or saved credentials. */
export function registerTerminal(
  app: Express,
  store: Store,
  identify: (req: Request) => Identity | undefined,
) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS ssh_hosts (ownerId TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(ownerId,host,port))',
  );
  const connections = new Map<string, Connection>();
  const write = (connection: Connection, event: Event) => {
    const line = `event: terminal\ndata: ${JSON.stringify(event)}\n\n`;
    if (connection.response) {
      if (!connection.response.write(line)) connection.channel?.pause();
    } else {
      connection.queuedBytes += Buffer.byteLength(line);
      if (connection.queuedBytes > 1024 * 1024) {
        finish(connection, 'Терминал отключён: браузер перестал принимать вывод.');
        return;
      }
      connection.queued.push(line);
    }
  };
  const finish = (connection: Connection, error?: string) => {
    if (connection.ended) return;
    connection.ended = true;
    connection.verify?.(false);
    connection.verify = undefined;
    connection.channel?.destroy();
    connection.client.destroy();
    // Make room for the terminal status even if an unattached peer flooded output.
    if (connection.queuedBytes > 1024 * 1024) {
      connection.queued = [];
      connection.queuedBytes = 0;
    }
    write(connection, { type: error ? 'error' : 'closed', ...(error ? { message: error } : {}) });
    connection.response?.end();
    clearTimeout(connection.detachTimer);
    connection.detachTimer = setTimeout(() => connections.delete(connection.id), 30_000);
    connection.detachTimer.unref();
  };
  const closeToken = (token: string) => {
    for (const connection of connections.values())
      if (connection.identity.token === token) finish(connection);
  };
  app.use('/api/terminal', (req, res, next) => {
    if (identify(req)?.id !== 'owner')
      return res.status(403).json({ error: 'Терминал доступен владельцу пространства.' });
    next();
  });
  app.post(
    '/api/terminal/connect',
    rateLimit({
      windowMs: 60_000,
      limit: 8,
      message: { error: 'Слишком много подключений. Подождите минуту.' },
    }),
    (req, res) => {
      const identity = identify(req)!;
      const body = z
        .object({
          host: z
            .string()
            .trim()
            .min(1)
            .max(253)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/)
            .transform((v) => v.toLowerCase()),
          port: z.number().int().min(1).max(65535).default(22),
          username: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .regex(/^[^\s\x00-\x1f]+$/),
          password: z.string().max(4096).optional(),
          privateKey: z.string().max(65536).optional(),
          passphrase: z.string().max(4096).optional(),
          cols: z.number().int().min(20).max(500).default(80),
          rows: z.number().int().min(5).max(200).default(24),
        })
        .refine((v) => !!v.password !== !!v.privateKey)
        .parse(req.body);
      if ([...connections.values()].filter((c) => !c.ended).length >= 4)
        return res.status(409).json({ error: 'Закройте одно из открытых подключений.' });
      const connection: Connection = {
        id: randomUUID(),
        identity,
        client: new ssh2.Client(),
        queued: [],
        queuedBytes: 0,
        ended: false,
        createdAt: Date.now(),
        host: body.host,
        port: body.port,
      };
      connections.set(connection.id, connection);
      connection.detachTimer = setTimeout(
        () => finish(connection, 'Браузер не подключился к терминалу.'),
        20_000,
      );
      connection.detachTimer.unref();
      const fail = (reason: string) => finish(connection, reason);
      connection.client.on('error', (error: Error & { level?: string }) => {
        fail(
          error.level === 'client-authentication'
            ? 'SSH не принял данные входа. Проверьте пользователя, пароль или ключ.'
            : 'Не удалось подключиться по SSH. Проверьте адрес, порт и доступность сервера.',
        );
      });
      connection.client.on('close', () => finish(connection));
      connection.client.on('ready', () => {
        // Credentials are never written to the database, filesystem, or logs.
        body.password = undefined;
        body.privateKey = undefined;
        body.passphrase = undefined;
        connection.client.shell(
          { term: 'xterm-256color', cols: body.cols, rows: body.rows },
          { env: { LANG: 'C.UTF-8' } },
          (error, channel) => {
            if (error || connection.ended) {
              channel?.destroy();
              fail('Не удалось открыть оболочку на сервере.');
              return;
            }
            connection.channel = channel;
            const decoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            channel.on('data', (data: Buffer) =>
              write(connection, { type: 'output', data: decoder.write(data) }),
            );
            channel.stderr.on('data', (data: Buffer) =>
              write(connection, { type: 'output', data: stderrDecoder.write(data) }),
            );
            channel.on('error', () => fail('Оболочка SSH завершилась с ошибкой.'));
            channel.on('close', () => finish(connection));
            write(connection, { type: 'ready' });
          },
        );
      });
      res.status(201).json({ id: connection.id });
      try {
        connection.client.connect({
          host: body.host,
          port: body.port,
          username: body.username,
          password: body.password,
          privateKey: body.privateKey,
          passphrase: body.passphrase,
          readyTimeout: 120_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
            const fingerprint =
              'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            const known = store.db
              .prepare('SELECT fingerprint FROM ssh_hosts WHERE ownerId=? AND host=? AND port=?')
              .get(identity.id, body.host, body.port) as { fingerprint: string } | undefined;
            if (known) {
              verify(known.fingerprint === fingerprint);
              if (known.fingerprint !== fingerprint)
                fail(
                  'Ключ SSH-сервера изменился. Подключение остановлено; проверьте сервер перед сбросом сохранённого ключа.',
                );
            } else {
              connection.fingerprint = fingerprint;
              connection.verify = verify;
              write(connection, {
                type: 'host-key',
                fingerprint,
                host: body.host,
                port: body.port,
              });
            }
          },
        });
      } catch {
        fail('Проверьте формат SSH-ключа и парольную фразу.');
      }
    },
  );
  app.delete('/api/terminal/known-host', (req, res) => {
    const { host, port } = z
      .object({
        host: z
          .string()
          .trim()
          .min(1)
          .max(253)
          .transform((v) => v.toLowerCase()),
        port: z.number().int().min(1).max(65535),
      })
      .parse(req.body);
    if ([...connections.values()].some((c) => !c.ended && c.host === host && c.port === port))
      return res.status(409).json({ error: 'Сначала отключитесь от этого сервера.' });
    store.db
      .prepare('DELETE FROM ssh_hosts WHERE ownerId=? AND host=? AND port=?')
      .run(identify(req)!.id, host, port);
    res.json({ ok: true });
  });
  app.use('/api/terminal/:id', (req, res, next) => {
    const connection = connections.get(req.params.id);
    const identity = identify(req);
    if (!connection || !identity || connection.identity.token !== identity.token)
      return res.status(404).json({ error: 'Подключение не найдено. Подключитесь заново.' });
    res.locals.terminal = connection;
    next();
  });
  app.get('/api/terminal/:id/events', (req, res) => {
    const connection = res.locals.terminal as Connection;
    if (connection.response)
      return res.status(409).json({ error: 'Терминал уже открыт в другой вкладке.' });
    if (!connection.ended) clearTimeout(connection.detachTimer);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    connection.response = res;
    for (const line of connection.queued) res.write(line);
    connection.queued = [];
    connection.queuedBytes = 0;
    if (connection.ended) {
      connection.response = undefined;
      res.end();
      return;
    }
    res.on('drain', () => connection.channel?.resume());
    const heartbeat = setInterval(() => {
      if (!identify(req) || Date.now() - connection.createdAt > 4 * 60 * 60_000)
        finish(connection, 'Сессия завершилась. Подключитесь заново.');
      else res.write(': keepalive\n\n');
    }, 15_000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      connection.response = undefined;
      if (!connection.ended) {
        connection.detachTimer = setTimeout(() => finish(connection), 10_000);
        connection.detachTimer.unref();
      }
    });
    connection.channel?.resume();
  });
  app.post('/api/terminal/:id/trust', (req, res) => {
    const connection = res.locals.terminal as Connection;
    const body = z.object({ fingerprint: z.string().max(100) }).parse(req.body);
    if (!connection.verify || connection.ended || body.fingerprint !== connection.fingerprint)
      return res.status(409).json({ error: 'Подтверждение ключа больше не ожидается.' });
    store.db
      .prepare(
        'INSERT INTO ssh_hosts (ownerId,host,port,fingerprint) VALUES (?,?,?,?) ON CONFLICT(ownerId,host,port) DO NOTHING',
      )
      .run(connection.identity.id, connection.host, connection.port, connection.fingerprint!);
    const known = store.db
      .prepare('SELECT fingerprint FROM ssh_hosts WHERE ownerId=? AND host=? AND port=?')
      .get(connection.identity.id, connection.host, connection.port) as { fingerprint: string };
    const verify = connection.verify;
    connection.verify = undefined;
    verify(known.fingerprint === connection.fingerprint);
    res.json({ ok: true });
  });
  app.post('/api/terminal/:id/input', (req, res) => {
    const connection = res.locals.terminal as Connection;
    const { data } = z.object({ data: z.string().min(1).max(16384) }).parse(req.body);
    if (connection.ended || !connection.channel)
      return res.status(409).json({ error: 'Терминал не подключён.' });
    if (connection.channel.writableLength > 65536)
      return res.status(429).json({ error: 'Сервер не успевает принимать ввод.' });
    connection.channel.write(data);
    res.json({ ok: true });
  });
  app.post('/api/terminal/:id/resize', (req, res) => {
    const connection = res.locals.terminal as Connection;
    const { cols, rows } = z
      .object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) })
      .parse(req.body);
    connection.channel?.setWindow(rows, cols, 0, 0);
    res.json({ ok: true });
  });
  app.delete('/api/terminal/:id', (req, res) => {
    finish(res.locals.terminal as Connection);
    res.json({ ok: true });
  });
  return {
    closeToken,
    close: () => {
      for (const connection of connections.values()) {
        finish(connection);
        clearTimeout(connection.detachTimer);
      }
      connections.clear();
    },
  };
}
