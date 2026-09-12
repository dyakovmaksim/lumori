import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
let transcribing = false;
export async function transcribe(
  config: Config,
  buffer: Buffer,
  language: string,
): Promise<string> {
  if (!config.speechPython || !config.speechModel || !existsSync(config.speechModel))
    throw new Error('Локальное распознавание ещё не настроено. Выберите браузерный режим.');
  if (transcribing) throw new Error('Уже распознаётся другая запись. Подождите немного.');
  transcribing = true;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'luma-voice-'));
    const audio = path.join(dir, 'voice');
    await writeFile(audio, buffer, { mode: 0o600 });
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        config.speechPython,
        [path.resolve('speech/transcribe.py'), config.speechModel, audio, language],
        {
          timeout: 180000,
          maxBuffer: 128 * 1024,
          env: { PATH: '/usr/bin:/bin', OMP_NUM_THREADS: '1', HF_HUB_OFFLINE: '1' },
        },
        (error, stdout) => {
          if (error)
            reject(new Error('Не удалось распознать запись. Проверьте длительность и повторите.'));
          else resolve(stdout);
        },
      );
    });
    const data = JSON.parse(output);
    if (typeof data.text !== 'string')
      throw new Error('Не удалось прочитать результат распознавания.');
    return data.text;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    transcribing = false;
  }
}
