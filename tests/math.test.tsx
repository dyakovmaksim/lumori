import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Markdown from '../src/components/Markdown';
import { normalizeMath } from '../src/components/normalize-math';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
describe('message math rendering', () => {
  it('renders the viscosity example without empty or duplicated equations', () => {
    const text = String.raw`Закон вязкости:

$$
\tau = \eta \frac{dv}{dy},
$$

где $\tau$ — напряжение, $\eta$ — вязкость.

$$
\nu = \frac{\eta}{\rho},
$$`;
    const html = render(text);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('<annotation encoding="application/x-tex"></annotation>');
    expect(normalizeMath(normalizeMath(text)).trim()).toBe(normalizeMath(text).trim());
  });
  it('renders slash delimiters including nested fractions and inline symbols', () => {
    const html = render(String.raw`где \(\eta\) — вязкость, \(\frac{\tau}{\frac{dv}{dy}}\) — отношение.
\[\nu=\frac{\eta}{\rho}\]`);
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html.match(/class="katex-display"/g)).toHaveLength(1);
    expect(html).not.toContain('katex-error');
  });
  it('preserves programming code and inline code', () => {
    const code = '```python\nprint("\\(x\\)")\n```\n`\\frac{a}{b}`';
    expect(normalizeMath(code)).toBe(code);
    expect(render(code)).not.toContain('class="katex"');
  });
  it('renders math fences and suppresses explicitly empty equations', () => {
    expect(render('```math\n\\frac{a}{b}\n```')).toContain('class="katex-display"');
    expect(render('$$\n\n$$')).not.toContain('class="katex-display"');
  });
  it('keeps incomplete streamed math intact and renders once completed', () => {
    const partial = String.raw`\[\frac{a}{b}`;
    expect(normalizeMath(partial)).toBe(partial);
    expect(render(partial + String.raw`\]`)).toContain('class="katex-display"');
  });
});
