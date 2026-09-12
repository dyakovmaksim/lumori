export type Mode = 'auto' | 'code' | 'write' | 'analyze' | 'study';
export type Attachment = { id: string; name: string; mime: string; size: number };
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: Attachment[];
  model?: string;
  status: 'complete' | 'streaming' | 'stopped' | 'error';
  createdAt: number;
  tokens?: number;
  activities?: Activity[];
};
export type Chat = {
  id: string;
  title: string;
  model: string;
  mode: Mode;
  temporary?: boolean;
  updatedAt: number;
  messages: Message[];
};
export type ChatSummary = Omit<Chat, 'messages'>;
export type Session = {
  user?: { id: string; name: string };
  authenticated: boolean;
  setupRequired: boolean;
  codexReady: boolean;
  codexError?: string;
  modelDetails: ModelInfo[];
  models: string[];
};

export type Activity = {
  id: string;
  label: string;
  detail: string;
  status: 'running' | 'complete' | 'error';
};
export type ModelInfo = {
  id: string;
  name: string;
  description: string;
  effort: string;
  default: boolean;
};
export type Artifact = { path: string; size: number; modifiedAt: number };

export type UsageLimits = {
  available: boolean;
  updatedAt?: number;
  error?: string;
  buckets: {
    id: string;
    name: string;
    windows: {
      id: string;
      usedPercent: number;
      durationMinutes: number | null;
      resetsAt: number | null;
    }[];
  }[];
};
