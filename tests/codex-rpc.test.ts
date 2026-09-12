import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../server/codex-rpc';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it('initializes once, multiplexes responses, rejects unauthorized origins and declines escalation', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => server.on('listening', r));
  cleanup.push(() => {
    server.clients.forEach((c) => c.terminate());
    server.close();
  });
  const methods: string[] = [];
  let approval: any;
  server.on('connection', (ws, request) => {
    expect(request.headers.authorization).toBe('Bearer local-test-token');
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method) {
        methods.push(m.method);
        if (m.id)
          ws.send(
            JSON.stringify({ id: m.id, result: m.method === 'initialize' ? {} : { ok: true } }),
          );
      } else if (m.id === 'approval-1') approval = m.result;
      if (m.method === 'initialized')
        ws.send(
          JSON.stringify({
            id: 'approval-1',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 't' },
          }),
        );
    });
  });
  const rpc = new CodexRpc(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    'local-test-token',
  );
  cleanup.push(() => rpc.close());
  await Promise.all([rpc.connect(), rpc.connect()]);
  const results = await Promise.all([rpc.request('account/read'), rpc.request('model/list')]);
  expect(results).toEqual([{ ok: true }, { ok: true }]);
  expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 10));
  expect(approval).toEqual({ decision: 'decline' });
  const invalid = new CodexRpc('ws://evil.example:8091', 'never-leak');
  await expect(invalid.connect()).rejects.toThrow('локальный');
});
it('fails pending requests when the Codex connection closes', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => server.on('listening', r));
  cleanup.push(() => server.close());
  server.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'turn/start') ws.close();
    }),
  );
  const rpc = new CodexRpc(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, '');
  cleanup.push(() => rpc.close());
  await rpc.connect();
  await expect(rpc.request('turn/start')).rejects.toThrow('прервалось');
});
