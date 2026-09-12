import type { UsageLimits } from '../shared/types.js';
// Return only quota fields; never expose account IDs, credit IDs or arbitrary backend payloads.
export function parseLimits(payload: any, now = Date.now()): UsageLimits {
  const byId = payload?.rateLimitsByLimitId;
  const snapshots =
    byId && typeof byId === 'object' && Object.keys(byId).length
      ? Object.entries(byId).map(([id, value]) => ({ id, value: value as any }))
      : [{ id: payload?.rateLimits?.limitId || 'codex', value: payload?.rateLimits }];
  const buckets = snapshots.flatMap(({ id, value }) => {
    if (!value) return [];
    const windows = ['primary', 'secondary'].flatMap((key) => {
      const w = value[key];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      return [
        {
          id: key,
          usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
          durationMinutes:
            typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0
              ? w.windowDurationMins
              : null,
          resetsAt:
            typeof w.resetsAt === 'number' && w.resetsAt > 0 && w.resetsAt < 8640000000000
              ? w.resetsAt * 1000
              : null,
        },
      ];
    });
    return windows.length
      ? [
          {
            id,
            name: id === 'codex' ? 'Codex' : String(value.limitName || id).slice(0, 80),
            windows,
          },
        ]
      : [];
  });
  return {
    available: buckets.length > 0,
    buckets,
    updatedAt: now,
    ...(!buckets.length ? { error: 'Codex пока не передал данные о лимитах.' } : {}),
  };
}
