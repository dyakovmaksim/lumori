import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../src/components/Markdown';

describe('file links rendered in assistant messages', () => {
  const chatId = 'test-chat';
  it.each([
    'output/report.xlsx',
    './output/report.xlsx',
    '/var/lib/luma-workspaces/test-chat/output/report.xlsx',
    'sandbox:/var/lib/luma-workspaces/test-chat/output/report.xlsx',
    'sandbox:/mnt/data/output/report.xlsx',
    'file:///var/lib/luma-workspaces/test-chat/output/report.xlsx',
  ])('renders %s as an authenticated download', (url) => {
    const html = renderToStaticMarkup(<Markdown chatId={chatId} text={`[Download](${url})`} />);
    expect(html).toContain('href="/api/chats/test-chat/artifact?path=output%2Freport.xlsx"');
  });
  it('preserves Unicode filenames without double encoding', () => {
    const html = renderToStaticMarkup(<Markdown chatId={chatId} text="[Файл](отчёт%20учёба.xlsx)" />);
    expect(html).toContain(`path=${encodeURIComponent('отчёт учёба.xlsx')}`);
  });
  it.each(['javascript:alert(1)', 'sandbox:/etc/passwd', '../secret.txt', '/var/lib/luma-workspaces/other/secret.txt'])('does not turn unsafe paths into downloads: %s', (url) => {
    const html = renderToStaticMarkup(<Markdown chatId={chatId} text={`[File](${url})`} />);
    expect(html).not.toContain('/api/chats/');
    expect(html).not.toContain('href="javascript:');
  });
  it('keeps web source links intact', () => {
    const html = renderToStaticMarkup(<Markdown chatId={chatId} text="[Source](https://example.com/report.xlsx)" />);
    expect(html).toContain('href="https://example.com/report.xlsx"');
  });
});
