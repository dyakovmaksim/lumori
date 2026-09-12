/** Consume each math/code region once. Never rewrite the inside of an equation. */
export function normalizeMath(source: string): string {
  let result = '';
  let i = 0;
  const display = (body: string) => body.trim() ? `\n\n$$\n${body.trim()}\n$$\n\n` : '';
  while (i < source.length) {
    const rest = source.slice(i);
    const fence = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(rest);
    if ((i === 0 || source[i - 1] === '\n') && fence) {
      const close = new RegExp(`^ {0,3}${fence[2][0]}{${fence[2].length},}[ \\t]*(?:\\n|$)`, 'm');
      const bodyStart = i + fence[0].length;
      const end = close.exec(source.slice(bodyStart));
      if (!end) { result += rest; break; }
      const next = bodyStart + end.index + end[0].length;
      const body = source.slice(bodyStart, bodyStart + end.index);
      result += /^(math|latex|tex|formula|equation)$/i.test(fence[3].trim())
        ? display(body.replace(/^\s*\$\$([\s\S]*?)\$\$\s*$/, '$1'))
        : source.slice(i, next);
      i = next;
      continue;
    }
    const ticks = /^`+/.exec(rest)?.[0];
    if (ticks) {
      const end = source.indexOf(ticks, i + ticks.length);
      const next = end < 0 ? source.length : end + ticks.length;
      result += source.slice(i, next); i = next; continue;
    }
    const opener = ['$$', '\\[', '\\(', '$'].find((s) => rest.startsWith(s));
    if (opener) {
      const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
      let end = source.indexOf(closer, i + opener.length);
      while (end >= 0 && source[end - 1] === '\\') end = source.indexOf(closer, end + closer.length);
      if (end >= 0) {
        const body = source.slice(i + opener.length, end);
        if (opener === '$$' || opener === '\\[') {
          result = result.replace(/\n+$/, '');
          result += display(body);
          while (source[end + closer.length] === '\n') end++;
        } else {
          result += `$${body.replace(/\n/g, ' ')}$`;
        }
        i = end + closer.length; continue;
      }
      // Leave a partial streamed expression intact until its closing delimiter arrives.
      result += rest; break;
    }
    if (source[i] === '\\' && i + 1 < source.length) {
      result += source.slice(i, i + 2); i += 2; continue;
    }
    result += source[i++];
  }
  return result;
}
