import { readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Artifact } from '../shared/types.js';
export function listArtifacts(root: string): Artifact[] {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  const result: Artifact[] = [];
  let visited = 0;
  function visit(dir: string, depth: number) {
    if (depth > 8 || result.length >= 200 || visited > 5000) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 5000 || result.length >= 200) return;
      if (
        item.name.startsWith('.') ||
        ['attachments', 'node_modules', '__pycache__', 'venv'].includes(item.name)
      )
        continue;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) visit(full, depth + 1);
      else if (item.isFile()) {
        const stat = lstatSync(full);
        result.push({ path: path.relative(root, full), size: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
  }
  visit(root, 0);
  return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
export function resolveArtifact(root: string, relative: string): string | undefined {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative)) return;
  const parts = relative.split(/[\\/]/);
  if (parts.some((p) => !p || p === '..' || p.startsWith('.')) || parts[0] === 'attachments')
    return;
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return;
  }
  const resolved = realpathSync(current);
  const base = realpathSync(root) + path.sep;
  if (!resolved.startsWith(base) || !lstatSync(resolved).isFile()) return;
  return resolved;
}
