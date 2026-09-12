import { afterEach, describe, expect, it } from 'vitest';
import { Server as SshServer, utils, type Connection } from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { getConfig } from '../server/config';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function waitFor(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for SSH event');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function setup() {
  const dir = mkdtempSync('/tmp/luma-terminal-');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
    publicKeyEncoding: { format: 'pem', type: 'pkcs1' },
  });
  const clientKeys = utils.generateKeyPairSync('ed25519', {
    passphrase: 'key-passphrase',
    cipher: 'aes256-cbc',
    rounds: 16,
  });
  const parsed = utils.parseKey(clientKeys.private, 'key-passphrase');
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
  let authentications = 0;
  const received: string[] = [];
  const dimensions: number[][] = [];
  const peers: Connection[] = [];
  const ssh = new SshServer({ hostKeys: [privateKey] }, (peer) => {
    peers.push(peer);
    peer.on('error', () => {});
    peer.on('authentication', (ctx) => {
      authentications++;
      if (
        ctx.method === 'password' &&
        ctx.username === 'tester' &&
        ctx.password === 'ssh-only-secret'
      )
        ctx.accept();
      else if (
        ctx.method === 'publickey' &&
        ctx.username === 'tester' &&
        parsed.getPublicSSH().equals(ctx.key.data) &&
        (!ctx.signature || parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
      )
        ctx.accept();
      else ctx.reject(['password', 'publickey']);
    });
    peer.on('ready', () =>
      peer.on('session', (accept) => {
        const session = accept();
        session.on('pty', (accept, _reject, info) => {
          dimensions.push([info.cols, info.rows]);
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          dimensions.push([info.cols, info.rows]);
          accept?.();
        });
        session.on('shell', (accept) => {
          const channel = accept();
          channel.write('SSH fixture ready\r\n');
          channel.on('data', (data: Buffer) => {
            received.push(data.toString());
            channel.write('echo: ' + data.toString());
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  const sshPort = (ssh.address() as AddressInfo).port;
  const instance = createApp(
    {
      ...getConfig(),
      dataDir: dir,
      workspaceDir: dir + '/workspaces',
      configured: true,
      password: 'test-owner-password',
      karinaPassword: 'test-karina-password',
      secret: 'x'.repeat(40),
      secure: false,
      origin: '',
    },
    {
      async status() {
        return { ready: true, models: [] };
      },
      async *stream() {},
    },
  );
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    instance.close();
    for (const peer of peers) peer.end();
    server.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => ssh.close(r))]);
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (
    path: string,
    cookie = '',
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    origin?: string,
  ) =>
    fetch(base + '/api' + path, {
      method,
      headers: {
        cookie,
        'x-lumori-request': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (username = 'owner') => {
    const r = await call('/login', '', {
      username,
      password: username === 'owner' ? 'test-owner-password' : 'test-karina-password',
    });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  const open = async (cookie: string, password = 'ssh-only-secret') => {
    const r = await call('/terminal/connect', cookie, {
      host: '127.0.0.1',
      port: sshPort,
      username: 'tester',
      password,
    });
    expect(r.status).toBe(201);
    return (await r.json()).id as string;
  };
  const events = async (id: string, cookie: string) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/terminal/${id}/events`, {
      headers: { cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const messages: Record<string, any>[] = [];
    let pending = '';
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const parts = pending.split('\n\n');
          pending = parts.pop()!;
          for (const part of parts) {
            const line = part.split('\n').find((v) => v.startsWith('data: '));
            if (line) messages.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* Aborted by test cleanup. */
      }
    })();
    cleanups.push(async () => {
      abort.abort();
      await pump;
    });
    return messages;
  };
  return {
    call,
    login,
    open,
    events,
    sshPort,
    clientKeys,
    received,
    dimensions,
    store: instance.store,
    authentications: () => authentications,
  };
}

describe('SSH terminal', () => {
  it('uses encrypted private keys and reuses the verified host pin', async () => {
    const s = await setup();
    const owner = await s.login();
    const body = {
      host: '127.0.0.1',
      port: s.sshPort,
      username: 'tester',
      privateKey: s.clientKeys.private,
      passphrase: 'key-passphrase',
    };
    const response = await s.call('/terminal/connect', owner, body);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const events = await s.events(id, owner);
    await waitFor(() => events.some((e) => e.type === 'host-key'));
    await s.call(`/terminal/${id}/trust`, owner, {
      fingerprint: events.find((e) => e.type === 'host-key')!.fingerprint,
    });
    await waitFor(() => events.some((e) => e.type === 'ready'));
    await s.call(`/terminal/${id}`, owner, undefined, 'DELETE');
    const second = await s.call('/terminal/connect', owner, body);
    const next = await s.events((await second.json()).id, owner);
    await waitFor(() => next.some((e) => e.type === 'ready'));
    expect(next.some((e) => e.type === 'host-key')).toBe(false);
  });
  it('requires owner login and same-origin mutations', async () => {
    const s = await setup();
    expect((await s.call('/terminal/connect', '', {})).status).toBe(401);
    const other = await s.login('karina');
    expect((await s.call('/terminal/connect', other, {})).status).toBe(403);
    const owner = await s.login();
    expect(
      (await s.call('/terminal/connect', owner, {}, 'POST', 'https://other.example')).status,
    ).toBe(403);
    expect(
      (await s.call('/terminal/connect', owner, { host: 'localhost', username: 'tester' })).status,
    ).toBe(400);
    expect(s.authentications()).toBe(0);
  });
  it('verifies host keys before authentication, streams a shell, resizes and revokes on logout', async () => {
    const s = await setup();
    const owner = await s.login();
    const id = await s.open(owner);
    const messages = await s.events(id, owner);
    await waitFor(() => messages.some((m) => m.type === 'host-key'));
    expect(s.authentications()).toBe(0);
    const fingerprint = messages.find((m) => m.type === 'host-key')!.fingerprint;
    expect(fingerprint).toMatch(/^SHA256:/);
    expect((await s.call(`/terminal/${id}/trust`, owner, { fingerprint: 'wrong' })).status).toBe(
      409,
    );
    const secondLogin = await s.login();
    expect((await s.call(`/terminal/${id}/input`, secondLogin, { data: 'pwd\r' })).status).toBe(
      404,
    );
    expect((await s.call(`/terminal/${id}/events`, secondLogin)).status).toBe(404);
    expect((await s.call(`/terminal/${id}/trust`, owner, { fingerprint })).status).toBe(200);
    await waitFor(() => messages.some((m) => m.type === 'ready'));
    expect(
      (await s.call(`/terminal/${id}/input`, owner, { data: 'Привет, Codex!\r' })).status,
    ).toBe(200);
    await waitFor(() => messages.some((m) => m.data?.includes('Привет, Codex!')));
    expect(s.received.join('')).toBe('Привет, Codex!\r');
    expect((await s.call(`/terminal/${id}/resize`, owner, { cols: 120, rows: 36 })).status).toBe(
      200,
    );
    await waitFor(() => s.dimensions.some((d) => d[0] === 120 && d[1] === 36));
    const stored = s.store.db.prepare('SELECT * FROM ssh_hosts').all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('ssh-only-secret');
    expect((await s.call('/logout', owner, {})).status).toBe(200);
    await waitFor(() => messages.some((m) => m.type === 'closed'));
    expect((await s.call(`/terminal/${id}/input`, owner, { data: 'pwd' })).status).toBe(401);
  });
  it('rejects a changed host key without sending credentials and supports forgetting its pin', async () => {
    const s = await setup();
    const owner = await s.login();
    s.store.db
      .prepare('INSERT INTO ssh_hosts VALUES (?,?,?,?)')
      .run('owner', '127.0.0.1', s.sshPort, 'SHA256:changed-key');
    const id = await s.open(owner);
    const messages = await s.events(id, owner);
    await waitFor(() => messages.some((m) => m.type === 'error'));
    expect(s.authentications()).toBe(0);
    expect(
      (
        await s.call(
          '/terminal/known-host',
          owner,
          { host: '127.0.0.1', port: s.sshPort },
          'DELETE',
        )
      ).status,
    ).toBe(200);
    expect(s.store.db.prepare('SELECT * FROM ssh_hosts').all()).toHaveLength(0);
  });
});
