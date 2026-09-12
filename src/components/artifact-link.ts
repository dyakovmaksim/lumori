// Convert model-local paths before ReactMarkdown sanitizes unsupported protocols.
export function artifactLink(url: string, chatId?: string): string | undefined {
  if (!chatId || !url || url.startsWith('#') || url.startsWith('//')) return;
  let file = url.replace(/^(?:sandbox:|file:\/\/)/i, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(file)) return;
  try {
    file = decodeURIComponent(file);
  } catch {
    return;
  }
  const workspace = `/var/lib/luma-workspaces/${chatId}/`;
  if (file.startsWith(workspace)) file = file.slice(workspace.length);
  else if (file.startsWith('/mnt/data/')) file = file.slice('/mnt/data/'.length);
  else if (file.startsWith('/')) return;
  file = file.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '');
  while (file.startsWith('./')) file = file.slice(2);
  if (!file || file.includes('\0') || file.includes('\\')) return;
  const parts = file.split('/');
  if (parts.some((part) => !part || part.startsWith('.')) || parts[0] === 'attachments') return;
  return `/api/chats/${encodeURIComponent(chatId)}/artifact?path=${encodeURIComponent(file)}`;
}
