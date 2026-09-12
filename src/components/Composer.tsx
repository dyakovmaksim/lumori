import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  AudioLines,
  Check,
  FileText,
  LoaderCircle,
  Mic,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { Attachment, Mode } from '../../shared/types';
export const MODES: { id: Mode; label: string }[] = [
  { id: 'auto', label: 'Диалог' },
  { id: 'study', label: 'Учёба' },
  { id: 'code', label: 'Код' },
  { id: 'write', label: 'Текст' },
  { id: 'analyze', label: 'Разбор' },
];
export const ACCEPT =
  '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xlsm,.xls,.ods,.docx,.doc,.odt,.pptx,.ppt,.rtf,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.sql,.sh,.go,.rs,.java,.c,.cpp,.h,.log';
export function AttachmentChip({ file, remove }: { file: Attachment; remove?: () => void }) {
  return (
    <div className="attachment-chip">
      {file.mime.startsWith('image/') ? (
        <img src={`/api/files/${file.id}`} alt={file.name} />
      ) : (
        <FileText size={21} />
      )}
      <span>
        <strong>{file.name}</strong>
        <small>{file.size < 1024 ? `${file.size} Б` : `${Math.round(file.size / 1024)} КБ`}</small>
      </span>
      {remove ? (
        <button aria-label={`Убрать ${file.name}`} onClick={remove}>
          <X size={14} />
        </button>
      ) : (
        <a
          href={`/api/files/${file.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Открыть ${file.name}`}
          className="attachment-open"
        />
      )}
    </div>
  );
}
export default function Composer({
  busy,
  mode,
  setMode,
  send,
  stop,
  draft,
  setDraft,
  language,
  speechMode,
  notify,
  ready,
}: {
  busy: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  send: (text: string, files: Attachment[]) => Promise<boolean>;
  stop: () => void;
  draft: string;
  setDraft: (s: string | ((s: string) => string)) => void;
  language: string;
  speechMode: string;
  notify: (s: string) => void;
  ready: boolean;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const media = useRef<MediaStream | null>(null);
  const speech = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const mounted = useRef(true);
  const uploadingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      media.current?.getTracks().forEach((t) => t.stop());
      speech.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!text.current) return;
    text.current.style.height = '0px';
    text.current.style.height = `${Math.min(text.current.scrollHeight, 190)}px`;
  }, [draft]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= 120) stopRecording();
  }, [seconds, recording]);
  async function addFiles(list: FileList | File[]) {
    if (!ready) return notify('Сначала настройте подключение и войдите в пространство.');
    if (uploadingRef.current || busy) return;
    const incoming = Array.from(list);
    if (files.length + incoming.length > 4)
      return notify('Можно прикрепить до 4 файлов за сообщение.');
    uploadingRef.current = true;
    setUploading(true);
    try {
      for (const file of incoming) {
        if (file.size > 10 * 1024 * 1024) {
          notify(`${file.name}: лимит 10 МБ.`);
          continue;
        }
        const body = new FormData();
        body.append('file', file);
        const result = await api<Attachment>('/files', { method: 'POST', body });
        if (mounted.current) setFiles((f) => [...f, result]);
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      uploadingRef.current = false;
      if (mounted.current) setUploading(false);
    }
  }
  function stopRecording() {
    speech.current?.stop();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    setRecording(false);
  }
  async function record() {
    if (starting) return;
    if (recording) return stopRecording();
    if (!ready) return notify('Сначала настройте подключение и войдите в пространство.');
    if (speechMode === 'browser') {
      // Web Speech is optional: browser/provider availability varies by device.
      const Speech =
        (
          window as unknown as {
            SpeechRecognition?: SpeechConstructor;
            webkitSpeechRecognition?: SpeechConstructor;
          }
        ).SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: SpeechConstructor })
          .webkitSpeechRecognition;
      if (!Speech)
        return notify(
          'Браузерное распознавание недоступно. Выберите «Whisper» в настройках голоса.',
        );
      const recognition = new Speech();
      speech.current = recognition;
      recognition.lang = language === 'en' ? 'en-US' : 'ru-RU';
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++)
          if (event.results[i].isFinal)
            setDraft((s) => `${s}${s ? ' ' : ''}${event.results[i][0].transcript}`);
      };
      recognition.onerror = () => {
        setRecording(false);
        notify(
          'Не удалось распознать речь в браузере. Проверьте разрешение микрофона или выберите Whisper.',
        );
      };
      recognition.onend = () => setRecording(false);
      try {
        recognition.start();
        setSeconds(0);
        setRecording(true);
      } catch {
        notify('Не удалось включить микрофон.');
      }
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      return notify(
        'Микрофон работает через HTTPS или localhost. Для VPS используйте SSH-туннель из инструкции.',
      );
    if (!window.MediaRecorder)
      return notify(
        'Запись не поддерживается этим браузером. Попробуйте Safari или Chrome последней версии.',
      );
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      media.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000,
      });
      recorder.current = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (mounted.current) {
          setRecording(false);
          notify('Ошибка записи. Проверьте микрофон.');
        }
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        setTranscribing(true);
        try {
          const blob = new Blob(chunks, { type: rec.mimeType });
          if (blob.size < 100) throw new Error('Запись пустая. Попробуйте ещё раз.');
          const body = new FormData();
          body.append('file', blob, `voice.${rec.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
          body.append('language', language);
          const result = await api<{ text: string }>('/transcribe', { method: 'POST', body });
          if (mounted.current) {
            setDraft((s) => `${s}${s ? ' ' : ''}${result.text}`);
            text.current?.focus({ preventScroll: true });
          }
        } catch (e) {
          if (mounted.current) notify((e as Error).message);
        } finally {
          if (mounted.current) setTranscribing(false);
        }
      };
      rec.start(500);
      setSeconds(0);
      setRecording(true);
    } catch {
      media.current?.getTracks().forEach((t) => t.stop());
      notify('Нет доступа к микрофону. Разрешите его в настройках браузера.');
    } finally {
      if (mounted.current) setStarting(false);
    }
  }
  async function submit() {
    if (
      busy ||
      uploading ||
      starting ||
      recording ||
      transcribing ||
      (!draft.trim() && !files.length)
    )
      return;
    // Remove attachments from the composer as soon as the request is handed
    // to the server. A long Codex turn should not make sent files look stuck
    // in the input; restore them only when the request was rejected early.
    const outgoing = files;
    setFiles([]);
    const accepted = await send(draft, outgoing);
    if (!accepted && mounted.current) setFiles(outgoing);
  }
  return (
    <div
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="composer">
        {dragging && (
          <div className="drop-overlay">
            <Paperclip /> Отпустите файлы здесь
          </div>
        )}
        {!!files.length && (
          <div className="attachments">
            {files.map((f) => (
              <AttachmentChip
                key={f.id}
                file={f}
                remove={() => setFiles((all) => all.filter((a) => a.id !== f.id))}
              />
            ))}
          </div>
        )}
        {recording ? (
          <div className="recording">
            <span className="record-dot" />
            <div className="waveform">
              {Array.from({ length: 22 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 0.07}s` }} />
              ))}
            </div>
            <span>
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </span>
            <span className="record-hint">Слушаю вас…</span>
          </div>
        ) : (
          <textarea
            ref={text}
            aria-label="Сообщение"
            placeholder="Спросите, придумайте, создайте…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={1}
            maxLength={32000}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !window.matchMedia('(pointer: coarse)').matches
              ) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void addFiles(e.clipboardData.files);
              }
            }}
          />
        )}
        <div className="composer-bottom">
          <div className="composer-left">
            <button
              className="icon-button attach-button"
              aria-label="Прикрепить файлы"
              title="Фото, PDF, Excel, Word, PowerPoint, текст и код · до 10 МБ"
              disabled={uploading || busy}
              onClick={() => input.current?.click()}
            >
              {uploading ? <LoaderCircle className="spin" size={19} /> : <Paperclip size={20} />}
            </button>
            <span className="toolbar-divider" />
            <select className="mode-select" aria-label="Режим ответа" value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy}>
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <div className="mode-switch" aria-label="Режим ответа">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={mode === m.id}
                  className={mode === m.id ? 'selected' : ''}
                  onClick={() => setMode(m.id)}
                  disabled={busy}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="composer-actions">
            <button
              className={`icon-button mic-button ${recording ? 'active' : ''}`}
              aria-label={recording ? 'Завершить запись' : 'Голосовой ввод'}
              title={transcribing ? 'Распознаю речь…' : 'Голосовой ввод'}
              disabled={starting || transcribing || busy}
              onClick={() => void record()}
            >
              {transcribing ? (
                <LoaderCircle className="spin" size={20} />
              ) : recording ? (
                <Check size={20} />
              ) : (
                <Mic size={20} />
              )}
            </button>
            <button
              className="send-button"
              aria-label={busy ? 'Остановить ответ' : 'Отправить сообщение'}
              disabled={
                !busy &&
                ((!draft.trim() && !files.length) ||
                  uploading ||
                  starting ||
                  recording ||
                  transcribing)
              }
              onClick={busy ? stop : () => void submit()}
            >
              {busy ? <Square size={15} fill="currentColor" /> : <ArrowUp size={21} />}
            </button>
          </div>
        </div>
      </div>
      <div className={`composer-caption ${transcribing ? 'is-transcribing' : ''}`}>
        <span>
          {transcribing ? (
            <>
              <AudioLines size={12} /> Превращаю голос в текст…
            </>
          ) : (
            'Место для ваших мыслей. Ответы AI могут быть неточными.'
          )}
        </span>
        <span className="enter-hint">
          ↵ отправить <span>·</span> ⇧ ↵ новая строка
        </span>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={ACCEPT}
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
interface SpeechInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: (event: {
    resultIndex: number;
    results: {
      length: number;
      [i: number]: { isFinal: boolean; [i: number]: { transcript: string } };
    };
  }) => void;
  onerror: () => void;
  onend: () => void;
}
type SpeechConstructor = new () => SpeechInstance;
