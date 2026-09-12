import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ArrowUp, ChevronLeft, LoaderCircle, Plug, SquareTerminal, X } from 'lucide-react';
import { api } from '../api';
import '@xterm/xterm/css/xterm.css';
import '../terminal.css';

type State = 'idle' | 'connecting' | 'verify' | 'ready' | 'closed';
export default function VpsTerminal({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const source = useRef<EventSource | null>(null);
  const connection = useRef<string | null>(null);
  const mounted = useRef(true);
  const output = useRef<string[]>([]);
  const inputQueue = useRef('');
  const sending = useRef(false);
  const [host, setHost] = useState(location.hostname);
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [auth, setAuth] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const [line, setLine] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const ready = state === 'ready';

  function disconnect() {
    const current = connection.current;
    connection.current = null;
    source.current?.close();
    source.current = null;
    inputQueue.current = '';
    if (current)
      void api(`/terminal/${current}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    try {
      const target = JSON.parse(localStorage.getItem('lumori-vps-target') || 'null');
      if (target && typeof target.host === 'string' && typeof target.username === 'string') {
        setHost(target.host);
        setPort(String(target.port || 22));
        setUsername(target.username);
      }
    } catch {
      /* Optional address history; never contains credentials. */
    }
    return () => {
      mounted.current = false;
      disconnect();
      dialog.current?.close();
    };
  }, []);

  async function send(data: string) {
    const current = connection.current;
    if (!current || !data) return;
    if (inputQueue.current.length + data.length > 65536) {
      setError('Слишком много текста. Отправьте его частями.');
      return;
    }
    inputQueue.current += data;
    if (sending.current) return;
    sending.current = true;
    try {
      while (inputQueue.current && connection.current === current) {
        const chunk = inputQueue.current.slice(0, 16384);
        inputQueue.current = inputQueue.current.slice(chunk.length);
        await api(`/terminal/${current}/input`, {
          method: 'POST',
          body: JSON.stringify({ data: chunk }),
        });
      }
    } catch (e) {
      inputQueue.current = '';
      if (mounted.current) setError((e as Error).message);
    } finally {
      sending.current = false;
    }
  }

  useEffect(() => {
    if (!id || !container.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      scrollback: 5000,
      screenReaderMode: true,
      theme: {
        background: '#171717',
        foreground: '#ededed',
        cursor: '#c5b1e7',
        selectionBackground: '#74609066',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    terminal.current = term;
    for (const chunk of output.current) term.write(chunk);
    output.current = [];
    const data = term.onData((value) => {
      void send(value);
    });
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!container.current?.clientWidth || !container.current.clientHeight) return;
        fit.fit();
        void api(`/terminal/${id}/resize`, {
          method: 'POST',
          body: JSON.stringify({
            cols: Math.max(20, Math.min(500, term.cols)),
            rows: Math.max(5, Math.min(200, term.rows)),
          }),
        }).catch(() => {});
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      data.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    disconnect();
    setId(null);
    setError('');
    setState('connecting');
    setLaunched(false);
    output.current = [];
    try {
      const result = await api<{ id: string }>('/terminal/connect', {
        method: 'POST',
        body: JSON.stringify({
          host,
          port: Number(port),
          username,
          ...(auth === 'password' ? { password } : { privateKey, passphrase }),
        }),
      });
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      if (!mounted.current) {
        void api(`/terminal/${result.id}`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      connection.current = result.id;
      setId(result.id);
      const events = new EventSource(`/api/terminal/${result.id}/events`);
      source.current = events;
      events.addEventListener('terminal', (event) => {
        if (!mounted.current || connection.current !== result.id) return;
        const message = JSON.parse((event as MessageEvent).data);
        if (message.type === 'output') {
          if (terminal.current) terminal.current.write(message.data);
          else output.current.push(message.data);
        } else if (message.type === 'host-key') {
          setFingerprint(message.fingerprint);
          setState('verify');
        } else if (message.type === 'ready') {
          setState('ready');
          try {
            localStorage.setItem(
              'lumori-vps-target',
              JSON.stringify({ host, port: Number(port), username }),
            );
          } catch {
            /* Optional. */
          }
        } else if (message.type === 'error' || message.type === 'closed') {
          events.close();
          setState('closed');
          if (message.message) setError(message.message);
          connection.current = null;
        }
      });
      events.onerror = () => {
        events.close();
        if (mounted.current && connection.current === result.id) {
          setState('closed');
          setError('Связь с терминалом прервалась. Подключитесь заново.');
          disconnect();
        }
      };
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        setState('idle');
      }
    }
  }
  async function trust() {
    try {
      await api(`/terminal/${id}/trust`, { method: 'POST', body: JSON.stringify({ fingerprint }) });
      setState((current) => (current === 'verify' ? 'connecting' : current));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function reset() {
    disconnect();
    setId(null);
    setState('idle');
    setError('');
  }
  function launch(command: string) {
    setLaunched(true);
    void send(command + '\r');
    terminal.current?.focus();
  }

  return (
    <dialog ref={dialog} className="vps-dialog" aria-labelledby="vps-title" onCancel={close}>
      <header className="vps-header">
        <div>
          <SquareTerminal size={22} />
          <div>
            <h2 id="vps-title">VPS и Codex</h2>
            <p>{id ? `${username}@${host}:${port}` : 'Работа с сервером прямо здесь'}</p>
          </div>
        </div>
        <button
          className="icon-button"
          aria-label={id ? 'Отключиться и закрыть терминал' : 'Закрыть терминал'}
          onClick={close}
        >
          <X size={20} />
        </button>
      </header>
      {!id ? (
        <form className="vps-connect" onSubmit={connect}>
          <div className="vps-intro">
            <h3>Подключись к своему серверу</h3>
            <p>Открой SSH-терминал, запусти установленный Codex и пиши ему задачи.</p>
          </div>
          <div className="vps-address">
            <label>
              Адрес VPS
              <input
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="IP или домен"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label>
              Порт
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
          </div>
          <label>
            Пользователь
            <input
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="vps-auth" role="group" aria-label="Способ входа">
            <button
              type="button"
              aria-pressed={auth === 'password'}
              onClick={() => setAuth('password')}
            >
              Пароль
            </button>
            <button type="button" aria-pressed={auth === 'key'} onClick={() => setAuth('key')}>
              SSH-ключ
            </button>
          </div>
          {auth === 'password' ? (
            <label>
              Пароль SSH
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
          ) : (
            <>
              <label>
                Приватный SSH-ключ
                <textarea
                  required
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={4}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="vps-key-file">
                Загрузить ключ из файла
                <input
                  type="file"
                  aria-label="Файл SSH-ключа"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 65536) {
                      setError('Размер ключа — до 64 КБ.');
                      return;
                    }
                    setPrivateKey(await file.text());
                  }}
                />
              </label>
              <label>
                Парольная фраза ключа
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                  placeholder="Если задана"
                />
              </label>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={state === 'connecting'}>
            {state === 'connecting' ? (
              <LoaderCircle className="spinning" size={17} />
            ) : (
              <Plug size={17} />
            )}{' '}
            {state === 'connecting' ? 'Подключаюсь…' : 'Подключиться'}
          </button>
          <p className="vps-note">
            Пароли и приватные ключи не сохраняются. Закрытие терминала завершает SSH-подключение.
          </p>
          <details className="vps-note">
            <summary>Если сервер переустановлен</summary>
            <p>
              После проверки нового ключа сервера можно удалить сохранённый отпечаток для указанного
              адреса и порта.
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                try {
                  await api('/terminal/known-host', {
                    method: 'DELETE',
                    body: JSON.stringify({ host, port: Number(port) }),
                  });
                  setError('Сохранённый отпечаток удалён. При подключении проверьте новый ключ.');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Забыть ключ сервера
            </button>
          </details>
        </form>
      ) : (
        <div className="vps-session">
          <div className="vps-toolbar">
            <span className={`vps-status ${ready ? 'is-ready' : ''}`}>
              {ready
                ? 'Подключено'
                : state === 'verify'
                  ? 'Проверка сервера'
                  : state === 'closed'
                    ? 'Отключено'
                    : 'Подключаюсь…'}
            </span>
            <div>
              {ready && !launched && (
                <>
                  <button onClick={() => launch('codex')}>Запустить Codex</button>
                  <button onClick={() => launch('codex resume')}>Продолжить диалог</button>
                </>
              )}
              <button onClick={reset}>
                <ChevronLeft size={15} />
                {state === 'closed' ? 'Новое подключение' : 'Отключиться'}
              </button>
            </div>
          </div>
          {state === 'verify' && (
            <div className="vps-verify" role="alert">
              <strong>Первое подключение к {host}</strong>
              <p>Сверь отпечаток SSH-ключа с данными сервера:</p>
              <code>{fingerprint}</code>
              <div>
                <button className="primary-button" onClick={() => void trust()}>
                  Доверять и подключиться
                </button>
                <button className="secondary-button" onClick={reset}>
                  Отмена
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="vps-error" role="alert">
              {error}
            </p>
          )}
          <div ref={container} className="vps-screen" aria-label="SSH-терминал" />
          {ready && (
            <div className="vps-input-area">
              <div className="vps-keys" aria-label="Клавиши терминала">
                {[
                  ['Esc', '\x1b'],
                  ['Tab', '\t'],
                  ['Ctrl+C', '\x03'],
                  ['↑', '\x1b[A'],
                  ['↓', '\x1b[B'],
                  ['←', '\x1b[D'],
                  ['→', '\x1b[C'],
                ].map(([label, value]) => (
                  <button key={label} type="button" onClick={() => void send(value)}>
                    {label}
                  </button>
                ))}
                <button type="button" onClick={() => terminal.current?.focus()}>
                  Клавиатура
                </button>
              </div>
              <form
                className="vps-line"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(line + '\r');
                  setLine('');
                }}
              >
                <input
                  aria-label="Команда или сообщение для Codex"
                  placeholder="Команда или сообщение для Codex…"
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button type="submit" aria-label="Отправить в терминал">
                  <ArrowUp size={20} />
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
