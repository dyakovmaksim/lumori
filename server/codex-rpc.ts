import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};
/** Private, server-to-server JSON-RPC. No browser can submit arbitrary Codex methods. */
export class CodexRpc extends EventEmitter {
  private ws?: WebSocket;
  private sequence = 0;
  private connecting?: Promise<void>;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private url: string,
    private token: string,
  ) {
    super();
  }
  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN && !this.connecting) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async open() {
    // Local endpoints only; never forward the bridge credential to a remote service.
    const endpoint = new URL(this.url);
    if (
      endpoint.protocol !== 'ws:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw new Error('Codex должен слушать локальный WebSocket.');
    const ws = new WebSocket(this.url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      maxPayload: 32 * 1024 * 1024,
      handshakeTimeout: 8000,
    });
    this.ws = ws;
    ws.on('message', (raw) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.method) {
        this.emit('notification', message);
        if (message.id !== undefined) this.replyToRequest(message);
        return;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Соединение с Codex прервалось.'));
      }
      this.pending.clear();
      this.emit('disconnect');
    });
    ws.on('error', () => {
      /* The open promise or close event reports the failure. */
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', () =>
        reject(new Error('Codex App Server недоступен. Проверьте службу Codex App Server.')),
      );
    });
    try {
      await this.request('initialize', {
      clientInfo: { name: 'lumori', title: 'Lumori Codex Workspace', version: '2.0.0' },
        capabilities: { experimentalApi: false },
      });
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch (error) {
      ws.close();
      throw error;
    }
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Codex не подключён.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex не ответил на ${method}.`));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Не удалось передать запрос в Codex.'));
        }
      });
    });
  }
  private replyToRequest(message: RpcMessage) {
    // Fail closed: the web UI never silently approves escalation, external tools, or user questions.
    let result: unknown;
    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval'
    )
      result = { decision: 'decline' };
    else if (message.method === 'item/permissions/requestApproval')
      result = { permissions: {}, scope: 'turn' };
    else if (message.method === 'item/tool/requestUserInput') result = { answers: {} };
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(
        JSON.stringify(
          result !== undefined
            ? { id: message.id, result }
            : {
                id: message.id,
                error: {
                  code: -32601,
                  message: 'This client does not support this server request.',
                },
              },
        ),
      );
  }
  close() {
    this.ws?.close();
  }
}
