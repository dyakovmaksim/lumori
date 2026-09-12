import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type TouchEvent } from 'react';
import { useChatScroll } from './useChatScroll';
const VpsTerminal = lazy(() => import('./components/VpsTerminal'));
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Asterisk,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  Download,
  FileSearch,
  FolderOpen,
  GraduationCap,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SquareTerminal,
  Sparkles,
  Sun,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api, readEvents } from './api';
import type {
  Attachment,
  Chat,
  ChatSummary,
  Message,
  Mode,
  Session,
  Activity,
  Artifact,
  UsageLimits,
} from '../shared/types';
import Composer, { AttachmentChip } from './components/Composer';
import Markdown, { download } from './components/Markdown';
import Modal from './components/Modal';
const MODEL_INFO: Record<string, { label: string; description: string; tag: string }> = {
  'gpt-5.6-luna': {
    label: 'GPT-5.6 Luna',
    description: 'Быстрые повседневные задачи',
    tag: 'Быстрый',
  },
  'gpt-5.6-terra': {
    label: 'GPT-5.6 Terra',
    description: 'Код и задачи с инструментами',
    tag: 'Практичный',
  },
  'gpt-5.5': { label: 'GPT-5.5', description: 'Универсальный помощник', tag: '' },
  'gpt-5.6-sol': {
    label: 'GPT-5.6 Sol',
    description: 'Для кода и вдумчивой работы',
    tag: 'Баланс',
  },
  'gpt-6-astra': { label: 'GPT-6 Astra', description: 'Для самых сложных вопросов', tag: 'Мощный' },
};
const modelLabel = (id: string) => MODEL_INFO[id]?.label || id;
function localRead(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
const prompts = [
  {
    mode: 'study' as Mode,
    icon: GraduationCap,
    title: 'Разобраться и научиться',
    description: 'Объяснение, пример и практика',
    color: 'peach',
    prompt: 'Я учусь программированию. Помоги разобраться в теме: ',
  },
  {
    mode: 'code' as Mode,
    icon: Code2,
    title: 'Создать что-то новое',
    description: 'Разобраться в коде и воплотить идею',
    color: 'lavender',
    prompt: 'Хочу воплотить идею в коде. Помоги продумать реализацию и задай нужные вопросы.',
  },
  {
    mode: 'analyze' as Mode,
    icon: FileSearch,
    title: 'Увидеть главное',
    description: 'Разложить сложное по полочкам',
    color: 'green',
    prompt:
      'Помоги разобраться в материале: выдели главное, объясни сложные места и предложи следующие шаги.',
  },
];
function LoginPage({
  username,
  password,
  busy,
  error,
  setUsername,
  setPassword,
  submit,
}: {
  username: string;
  password: string;
  busy: boolean;
  error: string;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  submit: (event: React.FormEvent) => void;
}) {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true">
          <Asterisk size={34} strokeWidth={1.5} />
        </div>
        <p className="login-brand">lumori<span>.</span></p>
        <p className="login-kicker"><LockKeyhole size={13} /> ЛИЧНОЕ ПРОСТРАНСТВО</p>
        <h1 id="login-title">Вход по приглашению</h1>
        <p className="login-copy">Ваши диалоги и файлы открываются только после входа.</p>
        <form onSubmit={submit} className="login-form">
          <div className="account-options" role="group" aria-label="Аккаунт">
            {[
              { id: 'owner', name: 'Моё пространство' },
              { id: 'karina', name: 'Карина' },
            ].map((account) => (
              <button
                type="button"
                key={account.id}
                aria-pressed={username === account.id}
                onClick={() => {
                  setUsername(account.id);
                  setPassword('');
                }}
              >
                {account.name}
              </button>
            ))}
          </div>
          <input type="hidden" name="username" autoComplete="username" value={username} />
          <label className="field-label" htmlFor="login-password">Пароль</label>
          <input
            id="login-password"
            className="text-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoFocus
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy}>
            {busy ? 'Открываю…' : 'Войти в Lumori'} <ArrowRight size={16} />
          </button>
        </form>
      </section>
    </main>
  );
}
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [model, setModel] = useState('gpt-5.6-sol');
  const [mode, setMode] = useState<Mode>('auto');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [sidebarDrag, setSidebarDrag] = useState(0);
  const sidebarDragRef = useRef(0);
  const sidebarTouch = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const [vpsOpen, setVpsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [modelMenu, setModelMenu] = useState(false);
  const [more, setMore] = useState(false);
  const [modal, setModal] = useState<
    'settings' | 'login' | 'rename' | 'delete' | 'setup' | 'limits' | null
  >(null);
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const quotaWindow = (limits?.buckets.find((b) => b.id === 'codex') || limits?.buckets[0])
    ?.windows[0];
  const [theme, setTheme] = useState(() => {
    const saved = localRead('lumori-theme', 'system');
    return saved === 'pink' ? 'system' : saved;
  });
  const [accent, setAccent] = useState('sage');
  const [speechMode, setSpeechMode] = useState(() =>
    localRead('lumori-speech', 'local') === 'browser' ? 'browser' : 'local',
  );
  const [language, setLanguage] = useState(() => localRead('lumori-language', 'auto'));
  const [toast, setToast] = useState('');
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [rename, setRename] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [copied, setCopied] = useState('');
  const [loadingChat, setLoadingChat] = useState(false);
  const [nextTemporary, setNextTemporary] = useState(false);
  const { feed, away, scrollProps, scrollToBottom } = useChatScroll(chat?.messages, busy);
  const search = useRef<HTMLInputElement>(null);
  const selectedId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const loadVersion = useRef(0);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = useRef<string | null>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!session?.authenticated) {
      setLimits(null);
      return;
    }
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const data = await api<UsageLimits>('/limits');
        if (live) setLimits(data);
      } catch {
        if (live)
          setLimits({ available: false, buckets: [], error: 'Лимиты временно недоступны.' });
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [session?.authenticated, session?.user?.id, busy]);

  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    let fullViewportHeight = 0;
    const update = () => {
      frame = 0;
      if (!viewport || viewport.scale === 1) {
        // Follow every animation frame, including keyboard dismissal after blur.
        // A focus/height threshold here switches coordinate systems mid-animation.
        const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
        const observedHeight = Math.max(layoutHeight, viewport?.height || 0);
        // Keep the last keyboard-free height. On iOS standalone both
        // innerHeight and clientHeight can shrink with the keyboard, so a
        // comparison against either one alone misses the transition.
        if (!fullViewportHeight || observedHeight > fullViewportHeight) {
          fullViewportHeight = observedHeight;
        }
        const inset = viewport
          ? Math.max(0, layoutHeight - viewport.height - viewport.offsetTop)
          : 0;
        const editing = document.activeElement?.matches('input, textarea, select') ?? false;
        const keyboard = Boolean(
          viewport && editing &&
            (document.documentElement.dataset.keyboard === 'true' ||
              fullViewportHeight - viewport.height > 140),
        );
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
          (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
        // visualViewport is shorter than the standalone app even when the
        // keyboard is closed on some iOS versions. Use the dynamic viewport
        // for the shell and switch to visualViewport only while editing.
        document.documentElement.style.setProperty(
          '--app-height',
          keyboard && viewport ? `${viewport.height}px` : standalone ? '100lvh' : '100dvh',
        );
        document.documentElement.style.setProperty(
          '--viewport-top',
          keyboard && viewport ? `${viewport.offsetTop}px` : '0px',
        );
        document.documentElement.style.setProperty('--viewport-inset', keyboard ? `${inset}px` : '0px');
        document.documentElement.style.setProperty(
          '--keyboard-offset',
          keyboard && viewport ? `${Math.max(0, fullViewportHeight - viewport.height - viewport.offsetTop)}px` : '0px',
        );
        document.documentElement.dataset.keyboard = String(keyboard);
      }
    };
    const resize = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const focus = () => {
      if (document.activeElement?.matches('input, textarea, select')) {
        document.documentElement.dataset.keyboard = 'true';
      }
      resize();
    };
    const blur = () => {
      requestAnimationFrame(() => {
        if (!document.activeElement?.matches('input, textarea, select')) {
          document.documentElement.dataset.keyboard = 'false';
        }
        resize();
      });
    };
    update();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    window.addEventListener('pageshow', resize);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('visibilitychange', resize);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pageshow', resize);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('visibilitychange', resize);
      delete document.documentElement.dataset.keyboard;
      for (const property of ['--app-height', '--viewport-top', '--viewport-inset', '--keyboard-offset'])
        document.documentElement.style.removeProperty(property);
    };
  }, []);

  function handleSidebarTouchStart(event: TouchEvent<HTMLElement>) {
    if (window.matchMedia('(min-width: 761px)').matches) return;
    const touch = event.touches[0];
    if (!touch) return;
    const edgeOpen = !sidebar && touch.clientX <= 34;
    const inMenu = (event.target as HTMLElement).closest('.sidebar');
    const menuClose = sidebar && Boolean(inMenu) && touch.clientX <= 300;
    sidebarTouch.current = edgeOpen || menuClose ? { x: touch.clientX, y: touch.clientY, active: false } : null;
  }
  function handleSidebarTouchMove(event: TouchEvent<HTMLElement>) {
    const start = sidebarTouch.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!start.active && Math.abs(dx) < 8) return;
    if (!start.active) {
      if (Math.abs(dy) > Math.abs(dx)) {
        sidebarTouch.current = null;
        return;
      }
      start.active = true;
    }
    event.preventDefault();
    const drag = sidebar ? Math.min(0, Math.max(-300, dx)) : Math.max(0, Math.min(300, dx));
    sidebarDragRef.current = drag;
    setSidebarDrag(drag);
  }
  function handleSidebarTouchEnd() {
    clearLongPress();
    const start = sidebarTouch.current;
    sidebarTouch.current = null;
    if (!start?.active) {
      sidebarDragRef.current = 0;
      setSidebarDrag(0);
      return;
    }
    const drag = sidebarDragRef.current;
    const shouldOpen = !sidebar && drag > 64;
    const shouldClose = sidebar && drag < -64;
    sidebarDragRef.current = 0;
    setSidebarDrag(0);
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (shouldOpen || shouldClose) setSidebar(shouldOpen);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#171717' : '#f2f4f8');
    };
    apply();
    media.addEventListener('change', apply);
    try {
      if (session?.user) localStorage.setItem(`lumori-theme-${session.user.id}`, theme);
    } catch {
      /* Preferences are optional. */
    }
    return () => media.removeEventListener('change', apply);
  }, [theme, session?.user?.id]);
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      if (session?.user) localStorage.setItem(`lumori-accent-${session.user.id}`, accent);
    } catch {
      /* Preferences are optional. */
    }
  }, [accent, session?.user?.id]);
  function applyAccount(s: Session) {
    setSession(s);
    const savedModel = s.user ? localRead(`lumori-model-${s.user.id}`, '') : '';
    setModel(s.models.includes(savedModel) ? savedModel : s.modelDetails.find((m) => m.default)?.id || s.models[0] || 'gpt-5.6-sol');
    if (s.user) {
      const savedTheme = localRead(`lumori-theme-${s.user.id}`, localRead('lumori-theme', 'system'));
      setTheme(['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'system');
      const savedAccent = localRead(
        `lumori-accent-${s.user.id}`,
        s.user.id === 'karina' || savedTheme === 'pink' ? 'pink' : 'sage',
      );
      setAccent(['sage', 'pink', 'blue', 'lavender'].includes(savedAccent) ? savedAccent : 'sage');
    }
  }
  useEffect(() => {
    try {
      localStorage.setItem('lumori-speech', speechMode);
      localStorage.setItem('lumori-language', language);
    } catch {
      /* Preferences are optional. */
    }
  }, [speechMode, language]);
  const refreshChats = useCallback(async () => {
    const list = await api<ChatSummary[]>('/chats');
    setChats(list);
  }, []);
  useEffect(() => {
    if (!session?.authenticated || !session.user) return;
    const id = localRead(`lumori-chat-${session.user.id}`, '');
    if (id) void openChat(id);
    // Restore once after authentication, not on conversation updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, session?.user?.id]);
  function forgetRememberedChat() {
    if (!session?.user) return;
    try {
      localStorage.removeItem(`lumori-chat-${session.user.id}`);
    } catch { /* Browser storage may be unavailable. */ }
  }
  function rememberChat(id: string | null, temporary = false) {
    if (!session?.user) return;
    try {
      const key = `lumori-chat-${session.user.id}`;
      // Temporary chats belong to this open app session. Never put their id in
      // persistent storage, otherwise a later visit resurrects the conversation.
      if (id && !temporary) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch { /* Browser storage may be unavailable. */ }
  }
  useEffect(() => {
    api<Session>('/session')
      .then((s) => {
        applyAccount(s);
        if (s.authenticated) void refreshChats().catch((e) => notify(e.message));
        else if (!s.setupRequired) setModal('login');
      })
      .catch((e) => notify(e.message));
    const unauthorized = () => {
      setSession((s) => (s ? { ...s, authenticated: false, user: undefined } : s));
      setChat(null);
      setChats([]);
      setModal('login');
    };
    window.addEventListener('lumori:unauthorized', unauthorized);
    return () => window.removeEventListener('lumori:unauthorized', unauthorized);
  }, [refreshChats, notify]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCollapsed(false);
        setSidebar(true);
        setTimeout(() => search.current?.focus(), 100);
      }
      if (e.key === 'Escape') {
        setModelMenu(false);
        setMore(false);
        setSidebar(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const refresh = () => {
      if (session?.authenticated && !busyRef.current) void refreshChats().catch(() => {});
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [session?.authenticated, refreshChats]);
  useEffect(() => {
    setArtifacts([]);
    if (!chat?.id || busy) return;
    let current = true;
    api<Artifact[]>(`/chats/${chat.id}/artifacts`)
      .then((files) => {
        if (current) setArtifacts(files);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [chat?.id, busy]);
  function newChat(temporary = false) {
    if (busyRef.current) return notify('Сначала остановите текущий ответ.');
    rememberChat(null);
    loadVersion.current++;
    selectedId.current = null;
    setComposerKey((k) => k + 1);
    setChat(null);
    setDraft('');
    setMode('auto');
    setNextTemporary(temporary);
    setSidebar(false);
    scrollToBottom();
    setLoadingChat(false);
  }
  async function openChat(id: string) {
    if (busyRef.current) return notify('Сначала остановите текущий ответ.');
    const version = ++loadVersion.current;
    setLoadingChat(true);
    setSidebar(false);
    try {
      const c = await api<Chat>(`/chats/${id}`);
      if (version !== loadVersion.current) return;
      if (c.temporary) {
        // A stale key can be left by an older build. Temporary chats must never
        // be restored after the site has been closed or the page reloaded.
        forgetRememberedChat();
        selectedId.current = null;
        setChat(null);
        setNextTemporary(true);
        setLoadingChat(false);
        return;
      }
      selectedId.current = id;
      rememberChat(id);
      setComposerKey((k) => k + 1);
      setChat(c);
      setModel(c.model);
      setMode(c.mode);
      setDraft('');
      scrollToBottom();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      if (version === loadVersion.current) setLoadingChat(false);
    }
  }
  async function changePreferences(nextModel = model, nextMode = mode) {
    setModelMenu(false);
    if (busyRef.current) return;
    try {
      if (chat) {
        const c = await api<Chat>(`/chats/${chat.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ model: nextModel, mode: nextMode }),
        });
        setChat(c);
      }
      setModel(nextModel);
      try {
        if (session?.user) localStorage.setItem(`lumori-model-${session.user.id}`, nextModel);
      } catch { /* Browser storage may be unavailable. */ }
      setMode(nextMode);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function send(text: string, attachments: Attachment[], retry = false): Promise<boolean> {
    if (!session?.authenticated) {
      setModal(session?.setupRequired ? 'setup' : 'login');
      return false;
    }
    if (!session.codexReady) {
      notify(session.codexError || 'Codex не подключён. Проверьте службу на сервере.');
      return false;
    }
    if (busyRef.current || loadingChat) return false;
    busyRef.current = true;
    setBusy(true);
    scrollToBottom();
    setToast('');
    let accepted = false;
    let currentChat = chat;
    try {
      if (!currentChat) {
        currentChat = await api<Chat>('/chats', {
          method: 'POST',
          body: JSON.stringify({ model, mode, temporary: nextTemporary }),
        });
        setChat(currentChat);
        selectedId.current = currentChat.id;
        rememberChat(currentChat.id, currentChat.temporary);
        setNextTemporary(false);
      }
      const response = await fetch(`/api/chats/${currentChat.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lumori-request': '1' },
        body: JSON.stringify({ text, attachmentIds: attachments.map((a) => a.id), retry }),
      });
      await readEvents(response, (event) => {
        if (event.type === 'start') {
          accepted = true;
          setDraft('');
          setChat(event.chat as Chat);
        }
        if (event.type === 'delta')
          setChat((c) =>
            c
              ? {
                  ...c,
                  messages: c.messages.map((m, i) =>
                    i === c.messages.length - 1 ? { ...m, text: m.text + event.text } : m,
                  ),
                }
              : c,
          );
        if (event.type === 'activity')
          setChat((c) =>
            c
              ? {
                  ...c,
                  messages: c.messages.map((m, i) =>
                    i === c.messages.length - 1
                      ? {
                          ...m,
                          activities: [
                            ...(m.activities || []).filter(
                              (a) => a.id !== (event.activity as Activity).id,
                            ),
                            event.activity as Activity,
                          ].slice(-40),
                        }
                      : m,
                  ),
                }
              : c,
          );
        if (event.type === 'error') notify(event.error as string);
        if (event.type === 'done')
          setChat((c) =>
            c
              ? {
                  ...c,
                  messages: c.messages.map((m, i) =>
                    i === c.messages.length - 1 ? (event.message as Message) : m,
                  ),
                }
              : c,
          );
      });
    } catch (e) {
      notify((e as Error).message);
      if (accepted && currentChat) {
        try {
          setChat(await api<Chat>(`/chats/${currentChat.id}`));
        } catch {
          /* Show original connection error. */
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refreshChats().catch(() => {});
    }
    return accepted;
  }
  async function stop() {
    if (!selectedId.current) return;
    try {
      await api(`/chats/${selectedId.current}/stop`, { method: 'POST' });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      applyAccount(await api<Session>('/session'));
      newChat();
      setPassword('');
      setModal(null);
      await refreshChats();
    } catch (e) {
      setLoginError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  }
  async function logout() {
    try {
      await api('/logout', { method: 'POST' });
      setSession((s) => (s ? { ...s, authenticated: false, user: undefined } : s));
      newChat();
      setChats([]);
      setModal('login');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function requestDelete(target: ChatSummary) {
    if (busyRef.current) return notify('Сначала остановите текущий ответ.');
    setDeleteTarget(target);
    setModal('delete');
  }
  function clearLongPress() {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  }
  async function deleteChat(target: ChatSummary) {
    try {
      await api(`/chats/${target.id}`, { method: 'DELETE' });
      const wasOpen = chat?.id === target.id;
      setModal(null);
      setDeleteTarget(null);
      if (wasOpen) newChat();
      await refreshChats();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function copy(message: Message) {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(message.id);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      notify('Копирование недоступно. Выделите текст или экспортируйте диалог.');
    }
  }
  function exportChat() {
    if (!chat) return;
    download(
      `# ${chat.title}\n\n${chat.messages.map((m) => `## ${m.role === 'user' ? 'Вы' : modelLabel(m.model || chat.model)}\n\n${m.text}${m.attachments.length ? '\n\nФайлы: ' + m.attachments.map((a) => a.name).join(', ') : ''}`).join('\n\n---\n\n')}`,
      `${chat.title.replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 50) || 'dialog'}.md`,
    );
    setMore(false);
  }
  const filtered = chats.filter((c) =>
    c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const hasMessages = !!chat?.messages.length;
  const temporaryMode = chat ? !!chat.temporary : nextTemporary;
  const now = new Date();
  const greeting =
    now.getHours() < 5
      ? 'Тихой ночи'
      : now.getHours() < 12
        ? 'Доброе утро'
        : now.getHours() < 18
        ? 'Добрый день'
        : 'Добрый вечер';
  if (!session) return <main className="login-page login-loading" aria-busy="true" />;
  if (!session.authenticated)
    return (
      <LoginPage
        username={username}
        password={password}
        busy={loginBusy}
        error={loginError}
        setUsername={(value) => {
          setUsername(value);
          setLoginError('');
        }}
        setPassword={setPassword}
        submit={login}
      />
    );
  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Закрыть меню"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebar ? 'mobile-open' : ''}`}
        style={sidebarDrag ? ({ '--sidebar-drag': `${sidebarDrag}px` } as CSSProperties) : undefined}
        onTouchStart={(event) => { event.stopPropagation(); handleSidebarTouchStart(event); }}
        onTouchMove={(event) => { event.stopPropagation(); handleSidebarTouchMove(event); }}
        onTouchEnd={(event) => { event.stopPropagation(); handleSidebarTouchEnd(); }}
        onTouchCancel={(event) => { event.stopPropagation(); handleSidebarTouchEnd(); }}
      >
        <div className="brand-row">
          <button className="brand" onClick={() => newChat()}>
            <span className="brand-mark">
              <Asterisk size={26} strokeWidth={1.7} />
            </span>
            lumori<span className="brand-dot">.</span>
          </button>
          <button
            className="icon-button sidebar-close"
            aria-label="Свернуть меню"
            onClick={() => {
              setCollapsed(true);
              setSidebar(false);
            }}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button className="new-chat" onClick={() => newChat()}>
          <Plus size={18} />
          <span>Новый диалог</span>
          <span className="new-chat-symbol">↗</span>
        </button>
        <label className="search-box">
          <Search size={16} />
          <input
            ref={search}
            placeholder="Найти диалог"
            aria-label="Найти диалог"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="sidebar-section-title">
          ВАШЕ ПРОСТРАНСТВО <span>{chats.length.toString().padStart(2, '0')}</span>
        </div>
        <nav className="chat-list" aria-label="Диалоги">
          {filtered.map((c) => (
            <div className={`chat-row ${chat?.id === c.id ? 'current' : ''}`} key={c.id}>
              <button
                className="chat-item"
                onPointerDown={() => {
                  clearLongPress();
                  pressTimer.current = setTimeout(() => {
                    longPress.current = c.id;
                    requestDelete(c);
                  }, 650);
                }}
                onPointerUp={clearLongPress}
                onPointerMove={clearLongPress}
                onPointerCancel={clearLongPress}
                onPointerLeave={clearLongPress}
                onClick={() => {
                  if (longPress.current === c.id) {
                    longPress.current = null;
                    return;
                  }
                  void openChat(c.id);
                }}
                aria-label={`Открыть диалог: ${c.title}. Удерживайте для удаления.`}
              >
                <MessageSquare size={16} />
                <span>{c.title}</span>
              </button>
              <button
                className="chat-delete"
                aria-label={`Удалить диалог: ${c.title}`}
                title="Удалить диалог"
                onClick={() => requestDelete(c)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!filtered.length && (
            <div className="history-empty">
              <div className="history-icon">
                <MessageSquare size={20} />
              </div>
              <p>{query ? 'Ничего не нашлось' : 'Всё начинается с диалога'}</p>
              <span>{query ? 'Попробуйте другие слова' : 'Ваши разговоры появятся здесь'}</span>
            </div>
          )}
        </nav>
        <div className="sidebar-note">
          <span className="little-star">✳</span>
          <p>
            Большие идеи
            <br />
            начинаются с любопытства.
          </p>
          <span className="note-line" />
        </div>
        <div className="sidebar-bottom">
          {session?.user?.id === 'owner' && <button className="settings-button" onClick={() => { setSidebar(false); setVpsOpen(true); }}><SquareTerminal size={18}/><span>VPS и Codex</span></button>}
          <button className="settings-button" onClick={() => setModal('settings')}>
            <Settings2 size={18} />
            <span>Настройки</span>
          </button>
          <div className="profile-row">
            <div className="avatar">
              {session?.user?.id === 'karina' ? 'К' : session?.authenticated ? 'Я' : 'L'}
            </div>
            <div>
              <strong>{session?.user?.name || 'Личное пространство'}</strong>
              <span>
                <i /> {session?.authenticated ? 'Только для вас' : 'Добро пожаловать'}
              </span>
            </div>
            <button
              className="icon-button"
              title="Переключить тему"
              aria-label="Переключить тему"
              onClick={() =>
                setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
              }
            >
              {theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </div>
      </aside>
      {vpsOpen && session?.user?.id === 'owner' && <Suspense fallback={<div className="loading-overlay">Открываю терминал…</div>}><VpsTerminal close={() => setVpsOpen(false)}/></Suspense>}
      <main
        className="main"
        onTouchStart={handleSidebarTouchStart}
        onTouchMove={handleSidebarTouchMove}
        onTouchEnd={handleSidebarTouchEnd}
        onTouchCancel={handleSidebarTouchEnd}
      >
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button menu-toggle"
              aria-label="Открыть меню"
              onClick={() => {
                setCollapsed(false);
                setSidebar(true);
              }}
            >
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>Lumori</span>
              <span className="slash">/</span>
              <strong>{temporaryMode ? 'Временный чат' : chat?.title || 'Новый диалог'}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <span className={`connection ${session?.codexReady ? 'connected' : ''}`}>
              <i />
              {session?.codexReady ? 'Codex подключён' : 'Codex недоступен'}
            </span>
            {session?.authenticated && (
              <button
                className="quota-button"
                onClick={() => setModal('limits')}
                aria-label="Показать лимиты Codex"
                title="Общие лимиты подписки"
              >
                <span>Лимиты</span>
                <strong>
                  {limits?.available && quotaWindow
                    ? `${Math.round(100 - quotaWindow.usedPercent)}%`
                    : '—'}
                </strong>
                {limits?.available && quotaWindow && (
                  <i style={{ width: `${100 - quotaWindow.usedPercent}%` }} />
                )}
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Настройки пространства"
              onClick={() => setModal('settings')}
            >
              <Settings2 size={18} />
            </button>
            {chat && (
              <div className="menu-anchor">
                <button
                  className="icon-button"
                  aria-label="Действия с диалогом"
                  onClick={() => setMore(!more)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {more && (
                  <>
                    <button
                      className="menu-dismiss"
                      aria-label="Закрыть действия"
                      onClick={() => setMore(false)}
                    />
                    <div className="dropdown actions-menu">
                      <button onClick={exportChat}>
                        <Download size={16} /> Экспорт в Markdown
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setRename(chat.title);
                          setMore(false);
                          setModal('rename');
                        }}
                      >
                        <Pencil size={16} /> Переименовать
                      </button>
                      <button
                        disabled={busy}
                        className="danger-text"
                        onClick={() => {
                          setMore(false);
                          requestDelete(chat);
                        }}
                      >
                        <Trash2 size={16} /> Удалить диалог
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </header>
        <div className={`workspace ${hasMessages ? 'with-messages' : ''}`}>
          <div
            className="conversation-scroll"
            ref={feed}
            {...scrollProps}
          >
            {!hasMessages ? (
              <div className={`welcome ${temporaryMode ? 'welcome-temporary' : ''}`} key={String(temporaryMode)}>
                <div className="welcome-orbit" aria-hidden="true">
                  <div className="orbit-glow" />
                  <span className="glass-loop loop-back" />
                  <span className="glass-loop loop-front" />
                  {temporaryMode ? <Clock3 size={73} strokeWidth={1.15} /> : <Asterisk size={73} strokeWidth={1.15} />}
                  <span className="orbit-dot dot-one" />
                  <span className="orbit-dot dot-two" />
                </div>
                <p className="greeting">
                  {temporaryMode ? 'Временный режим включён' : greeting} <span>✦</span>
                </p>
                <h1>
                  {temporaryMode ? 'Разговор на сейчас.' : 'С чего начнём?'}
                </h1>
                <p className="welcome-description">
                  {temporaryMode ? 'Без сохранения в истории. Чат и его файлы удалятся через 24 часа.' : 'Вопрос, идея или файл — я рядом, чтобы помочь.'}
                </p>
                <div className="prompt-grid">
                  {prompts.map((p) => (
                    <button
                      className={`prompt-card ${p.color}`}
                      key={p.mode}
                      onClick={() => {
                        void changePreferences(model, p.mode);
                        setDraft(p.prompt);
                        document.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
                      }}
                    >
                      <div className="prompt-top">
                        <span className="prompt-icon">
                          <p.icon size={21} strokeWidth={1.5} />
                        </span>
                        <ArrowUpRight size={17} />
                      </div>
                      <strong>{p.title}</strong>
                      <span>{p.description}</span>
                    </button>
                  ))}
                </div>
                <div className="welcome-hint">
                  <FolderOpen size={14} />
                  <span>Добавьте фото или файл — разберёмся вместе</span>
                </div>
              </div>
            ) : (
              <div className="messages">
                {chat.messages.map((m, index) => (
                  <article className={`message ${m.role}`} key={m.id}>
                    <div className="message-meta">
                      {m.role === 'assistant' ? (
                        <span className="assistant-mark">
                          <Asterisk size={18} />
                        </span>
                      ) : (
                        <span className="user-mark">Я</span>
                      )}
                      <strong>{m.role === 'assistant' ? 'Lumori' : 'Вы'}</strong>
                      {m.role === 'assistant' && <span>{modelLabel(m.model || chat.model)}</span>}
                      <time>
                        {new Date(m.createdAt).toLocaleTimeString('ru-RU', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    {!!m.attachments.length && (
                      <div className="attachments message-attachments">
                        {m.attachments.map((a) => (
                          <AttachmentChip file={a} key={a.id} />
                        ))}
                      </div>
                    )}
                    {m.role === 'assistant' && (m.status === 'streaming' || !!m.activities?.length) && (
                      <details className={`agent-activity compact-activity ${m.status === 'streaming' ? 'is-running' : ''}`}>
                        <summary>
                          <span className="activity-indicator" aria-hidden="true" />
                          <span role="status" aria-live="polite">
                            {m.status === 'streaming'
                              ? [...(m.activities || [])].reverse().find((a) => a.status === 'running')?.label || 'Готовлю ответ'
                              : 'Действия'}
                          </span>
                          <span className="activity-count">{m.activities?.length || ''}</span>
                          <ChevronDown size={13} />
                        </summary>
                        {!m.activities?.length && <p className="activity-wait">Начинаю работу над задачей…</p>}
                        {m.activities?.map((a) => (
                          <div key={a.id} className={`activity-row ${a.status}`}>
                            <span>
                              {a.status === 'running' ? '◌' : a.status === 'error' ? '!' : '✓'}
                            </span>
                            <div>
                              <strong>{a.label}</strong>
                              <code>{a.detail}</code>
                            </div>
                          </div>
                        ))}
                      </details>
                    )}
                    {m.text ? (
                      m.role === 'assistant' ? (
                        <Markdown text={m.text} chatId={chat.id} />
                      ) : (
                        <div className="user-text">{m.text}</div>
                      )
                    ) : m.status === 'streaming' && !m.activities?.length ? (
                      <div className="thinking" aria-label="Модель думает">
                        <i />
                        <i />
                        <i />
                        <span>Собираю мысли…</span>
                      </div>
                    ) : null}
                    {m.role === 'assistant' && m.status !== 'streaming' && (
                      <div className="message-tools">
                        <button
                          aria-label="Скопировать ответ"
                          title="Скопировать ответ"
                          onClick={() => void copy(m)}
                        >
                          {copied === m.id ? <Check size={15} /> : <Copy size={15} />}
                        </button>
                        {index === chat.messages.length - 1 && (
                          <button
                            disabled={busy}
                            title="Ответить заново"
                            aria-label="Ответить заново"
                            onClick={() => void send('', [], true)}
                          >
                            <RotateCcw size={15} />
                          </button>
                        )}
                        {m.status === 'stopped' && <span>Ответ остановлен</span>}
                        {m.status === 'error' && (
                          <span className="danger-text">Ответ не завершён · можно повторить</span>
                        )}
                        {!!m.tokens && (
                          <span className="token-count">
                            {m.tokens.toLocaleString('ru-RU')} токенов
                          </span>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
          {loadingChat && <div className="loading-overlay">Открываю диалог…</div>}
          <div className="composer-area">
            {away && hasMessages && (
              <button
                className="scroll-bottom"
                aria-label="К последнему сообщению"
                onClick={scrollToBottom}
              >
                <ArrowDown size={18} />
              </button>
            )}
            <div className="composer-heading">
              <div className="menu-anchor model-anchor">
                <button
                  className="model-button"
                  aria-label={`Выбрать модель: ${modelLabel(model)}`}
                  disabled={busy}
                  aria-expanded={modelMenu}
                  onClick={() => setModelMenu(!modelMenu)}
                >
                  <span className="model-spark">
                    <Sparkles size={14} />
                  </span>
                  {modelLabel(model)}
                  <ChevronDown size={14} />
                </button>
                {modelMenu && (
                  <>
                    <button
                      className="menu-dismiss"
                      aria-label="Закрыть выбор модели"
                      onClick={() => setModelMenu(false)}
                    />
                    <div className="dropdown model-menu">
                      <div className="dropdown-label">МОДЕЛЬ ДЛЯ СЛЕДУЮЩЕГО ОТВЕТА</div>
                      {(session?.models || Object.keys(MODEL_INFO)).map((id) => (
                        <button
                          key={id}
                          onClick={() => void changePreferences(id)}
                          className={model === id ? 'model-selected' : ''}
                        >
                          <span className="model-list-icon">
                            {id.includes('mini') ? <Zap size={18} /> : <Sparkles size={18} />}
                          </span>
                          <span>
                            <strong>{modelLabel(id)}</strong>
                            <small>
                              {MODEL_INFO[id]?.description || 'Модель из настроек сервера'}
                            </small>
                          </span>
                          {model === id ? (
                            <Check size={16} />
                          ) : (
                            <span className="model-tag">{MODEL_INFO[id]?.tag}</span>
                          )}
                        </button>
                      ))}
                      <p>Модели вашей учётной записи Codex.</p>
                    </div>
                  </>
                )}
              </div>
              <button
                className={`temporary-toggle ${temporaryMode ? 'is-on' : ''}`}
                aria-pressed={temporaryMode}
                disabled={busy}
                title={hasMessages ? 'Открыть новый диалог в другом режиме' : 'Не сохранять новый чат в истории'}
                onClick={() => {
                  if (chat) newChat(!temporaryMode);
                  else setNextTemporary(!temporaryMode);
                }}
              >
                <Clock3 size={15} />
                <span>Временный<span className="temporary-state"> · {temporaryMode ? 'вкл' : 'выкл'}</span></span>
                <i className="toggle-track" aria-hidden="true"><i /></i>
              </button>
            </div>
            {!!artifacts.length && chat && (
              <details className="workspace-files">
                <summary>
                  <FolderOpen size={14} /> Файлы Codex <span>{artifacts.length}</span>
                </summary>
                <div>
                  {artifacts.map((file) => (
                    <a
                      key={file.path}
                      href={`/api/chats/${chat.id}/artifact?path=${encodeURIComponent(file.path)}`}
                    >
                      <Download size={14} />
                      <span>{file.path}</span>
                      <small>{Math.max(1, Math.round(file.size / 1024))} КБ</small>
                    </a>
                  ))}
                </div>
              </details>
            )}
            <Composer
              key={composerKey}
              busy={busy || loadingChat}
              mode={mode}
              setMode={(m) => void changePreferences(model, m)}
              send={send}
              stop={() => void stop()}
              draft={draft}
              setDraft={setDraft}
              language={language}
              speechMode={speechMode}
              notify={notify}
              ready={!!session?.authenticated}
            />
            {!session?.codexReady && (
              <button className="setup-hint" onClick={() => setModal('setup')}>
                <span className="status-dot" /> Подключите Codex, чтобы начать разговор{' '}
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </main>
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button aria-label="Закрыть уведомление" onClick={() => setToast('')}>
            <X size={17} />
          </button>
        </div>
      )}
      {modal === 'limits' && (
        <Modal title="Лимиты Codex" close={() => setModal(null)}>
          <p className="modal-copy">
            Общая подписка для вас и Карины, включая работу Codex вне сайта.
          </p>
          {!limits ? (
            <p className="setting-description">Получаем данные Codex…</p>
          ) : !limits.available ? (
            <p className="setting-description" role="status">
              {limits.error || 'Данные пока недоступны.'}
            </p>
          ) : (
            limits.buckets.map((bucket) => (
              <section className="quota-bucket" key={bucket.id}>
                <h3>{bucket.name}</h3>
                {bucket.windows.map((window) => {
                  const minutes = window.durationMinutes;
                  const label =
                    minutes === 300
                      ? 'За 5 часов'
                      : minutes === 10080
                        ? 'За неделю'
                        : minutes
                          ? `За ${minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`}`
                          : window.id === 'primary'
                            ? 'Основной период'
                            : 'Дополнительный период';
                  const used = Math.round(window.usedPercent);
                  return (
                    <div className="quota-window" key={window.id}>
                      <div className="quota-row">
                        <strong>{label}</strong>
                        <span>Осталось {Math.round(100 - window.usedPercent)}%</span>
                      </div>
                      <div
                        className={`quota-track ${used >= 90 ? 'quota-low' : ''}`}
                        role="progressbar"
                        aria-label={`${bucket.name}: ${label}, использовано`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={window.usedPercent}
                      >
                        <i style={{ width: `${window.usedPercent}%` }} />
                      </div>
                      <div className="quota-row quota-caption">
                        <span>Использовано {used}%</span>
                        <span>
                          {window.resetsAt
                            ? window.resetsAt <= Date.now()
                              ? 'Ожидаем обновления периода'
                              : `Сброс ${new Date(window.resetsAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                            : 'Время сброса не передано'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))
          )}
          <p className="setting-description">
            Проценты сообщает Codex. Это не количество сообщений и не токены отдельного чата.
            Обновление раз в минуту и после ответа; время — по вашему устройству.
          </p>
          {limits?.updatedAt && (
            <p className="quota-caption">
              Проверено в{' '}
              {new Date(limits.updatedAt).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          )}
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal title="Ваше пространство" close={() => setModal(null)} className="settings-modal">
          <div className="settings-section">
            <span className="settings-label">ТЕМА</span>
            <div className="theme-options">
              {[
                { id: 'light', label: 'Светлая', icon: Sun },
                { id: 'dark', label: 'Тёмная', icon: Moon },
                { id: 'system', label: 'Системная', icon: Monitor },
              ].map((t) => (
                <button
                  key={t.id}
                  aria-pressed={theme === t.id}
                  className={theme === t.id ? 'chosen' : ''}
                  onClick={() => setTheme(t.id)}
                >
                  <t.icon size={22} />
                  <span>{t.label}</span>
                  {theme === t.id && <Check size={13} />}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <span className="settings-label">АКЦЕНТНЫЙ ЦВЕТ</span>
            <div className="accent-options" role="group" aria-label="Акцентный цвет">
              {[
                { id: 'sage', label: 'Шалфей', color: '#9eaf82' },
                { id: 'pink', label: 'Розовый', color: '#d18aad' },
                { id: 'blue', label: 'Голубой', color: '#83a8d8' },
                { id: 'lavender', label: 'Лаванда', color: '#ad94d6' },
              ].map((option) => (
                <button
                  type="button"
                  key={option.id}
                  aria-pressed={accent === option.id}
                  onClick={() => setAccent(option.id)}
                >
                  <span className="accent-swatch" style={{ background: option.color }}>
                    {accent === option.id && <Check size={16} />}
                  </span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            <p className="setting-description">
              Любой акцент сочетается со светлой и тёмной темой.
            </p>
          </div>
          <div className="settings-section">
            <span className="settings-label">ГОЛОСОВОЙ ВВОД</span>
            <label className="setting-row">
              <span>Распознавание</span>
              <select value={speechMode} onChange={(e) => setSpeechMode(e.target.value)}>
                <option value="local">Whisper · локально на VPS</option>
                <option value="browser">Встроенное в браузер</option>
              </select>
            </label>
            <p className="setting-description">
              {speechMode === 'local'
                ? 'Запись до 2 минут. Русский и английский. Whisper распознаёт речь на CPU вашего VPS без API и расходов токенов. После обработки запись удаляется.'
                : 'Поддержка зависит от браузера; запись может обрабатываться его облачным сервисом. Для этого режима выберите язык.'}
            </p>
            <label className="setting-row">
              <span>Язык речи</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">Авто · RU / EN</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </label>
            <p className="setting-description">
              {speechMode === 'browser' && language === 'auto'
                ? 'В браузерном режиме «Авто» использует русский язык. '
                : ''}
              Распознанный текст сначала появится в поле ввода — его можно исправить.
            </p>
          </div>
          <div className="settings-section">
            <span className="settings-label">ПОДКЛЮЧЕНИЕ И ДАННЫЕ</span>
            <div className="setting-row">
              <span>Codex на VPS</span>
              <span className={`connection ${session?.codexReady ? 'connected' : ''}`}>
                <i />
                {session?.codexReady ? 'ChatGPT подключён' : 'Ожидает входа'}
              </span>
            </div>
            <p className="setting-description">
              Сайт управляет установленным Codex через вашу авторизацию ChatGPT. Codex работает с
              файлами и командами в папке диалога. Запросы к моделям используют лимиты вашей учётной
              записи. Настройки темы и голоса сохраняются на этом устройстве.
            </p>
            <button className="text-button" onClick={() => setModal('setup')}>
              Как подключить <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="modal-footer">
            <span className="version">
              lumori. <span>v2.0 · Codex</span>
            </span>
            {session?.authenticated ? (
              <button className="text-button" disabled={busy} onClick={() => void logout()}>
                <LogOut size={15} /> Выйти
              </button>
            ) : (
              <button
                className="primary-button"
                onClick={() => setModal(session?.setupRequired ? 'setup' : 'login')}
              >
                Войти
              </button>
            )}
          </div>
        </Modal>
      )}
      {modal === 'setup' && (
        <Modal title="Почти готовы к разговору" close={() => setModal(null)}>
          <div className="setup-art">
            <Asterisk size={44} />
          </div>
          <p className="modal-copy">
            Lumori подключается к установленному на VPS Codex. Отдельный API-ключ не нужен.
          </p>
          <ol className="setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Авторизация Codex</strong>
                <p>На сервере должен быть выполнен вход Codex через ChatGPT.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Служба App Server</strong>
                <p>Codex App Server передаёт сайту ответы, действия и список доступных моделей.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>{session?.user?.name || 'Личное пространство'}</strong>
                <p>Войдите по паролю сайта. Диалоги и файлы сохраняются на VPS.</p>
              </div>
            </li>
          </ol>
          <button className="primary-button full-width" onClick={() => location.reload()}>
            Проверить подключение <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {modal === 'rename' && chat && (
        <Modal title="Название диалога" close={() => setModal(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const c = await api<Chat>(`/chats/${chat.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ title: rename }),
                });
                setChat(c);
                setModal(null);
                await refreshChats();
              } catch (error) {
                notify((error as Error).message);
              }
            }}
          >
            <input
              className="text-input"
              aria-label="Название диалога"
              maxLength={100}
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              autoFocus
              required
            />
            <button className="primary-button full-width">Сохранить</button>
          </form>
        </Modal>
      )}
      {modal === 'delete' && deleteTarget && (
        <Modal title="Удалить диалог?" close={() => setModal(null)}>
          <p className="modal-copy">
            «{deleteTarget.title}», его вложения и рабочие файлы будут удалены с сайта. Сессия Codex будет
            архивирована. Это действие нельзя отменить.
          </p>
          <div className="confirm-actions">
            <button className="secondary-button" onClick={() => setModal(null)}>
              Оставить
            </button>
            <button
              className="danger-button"
              onClick={() => void deleteChat(deleteTarget)}
            >
              Удалить
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
