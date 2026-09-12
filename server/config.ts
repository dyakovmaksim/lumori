import 'dotenv/config';
import path from 'node:path';
export function getConfig() {
  const password = process.env.APP_PASSWORD || '';
  const secret = process.env.SESSION_SECRET || '';
  return {
    password,
    karinaPassword: process.env.KARINA_PASSWORD || '',
    secret,
    configured: password.length >= 12 && secret.length >= 32,
    speechPython: process.env.SPEECH_PYTHON || '',
    speechModel: process.env.SPEECH_MODEL_PATH || '',
    codexUrl: process.env.CODEX_WS_URL || 'ws://127.0.0.1:8091',
    codexToken: process.env.CODEX_WS_TOKEN || '',
    defaultModel: process.env.CODEX_MODEL || 'gpt-5.6-sol',
    workspaceDir: path.resolve(process.env.WORKSPACE_DIR || './workspaces'),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    origin: process.env.APP_ORIGIN || '',
    secure: process.env.COOKIE_SECURE === 'true',
    trustProxy: process.env.TRUST_PROXY === 'true',
    turnTimeout: Math.max(60_000, Number(process.env.TURN_TIMEOUT_MS) || 900_000),
    maxStorage: (Number(process.env.MAX_STORAGE_MB) || 512) * 1024 * 1024,
  };
}
export type Config = ReturnType<typeof getConfig>;
