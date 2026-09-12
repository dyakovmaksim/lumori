export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: {
      'x-lumori-request': '1',
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/login')
      window.dispatchEvent(new Event('lumori:unauthorized'));
    throw new Error(data.error || 'Не удалось выполнить запрос.');
  }
  return data;
}
export async function readEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
) {
  if (!response.ok) {
    const data = await response.json();
      if (response.status === 401) window.dispatchEvent(new Event('lumori:unauthorized'));
    throw new Error(data.error || 'Не удалось отправить сообщение.');
  }
  if (!response.body) throw new Error('Браузер не поддерживает потоковый ответ.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEvent = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts)
        if (part.startsWith('data: ')) {
          const event = JSON.parse(part.slice(6));
          if (event.type === 'done') doneEvent = true;
          onEvent(event);
        }
    }
    if (!doneEvent)
      throw new Error('Соединение прервалось. Ответ сохранён на сервере; откройте диалог заново.');
  } finally {
    reader.releaseLock();
  }
}
