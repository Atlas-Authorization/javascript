// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderPolicyFragment, sanitizePolicyFragment, sanitizePolicyHtml } from './policy-dom';

describe('policy sanitizer (allow-list, no innerHTML)', () => {
  it('drops script, iframe and other active content with their text', () => {
    const out = sanitizePolicyHtml('<p>a<script>evil()</script><iframe src="//e">inner</iframe><object data="x"></object><style>p{}</style></p>');
    expect(out).toBe('<p>a</p>');
  });

  it('drops on* attributes and style', () => {
    const out = sanitizePolicyHtml('<p onclick="x()" style="color:red" onmouseover="y()">t</p>');
    expect(out).toBe('<p>t</p>');
  });

  it('removes javascript: hrefs including obfuscated forms', () => {
    for (const href of ['javascript:evil()', 'JaVaScRiPt:evil()', 'java\tscript:evil()', ' \n javascript:evil()', '&#106;avascript:evil()', 'vbscript:x']) {
      const out = sanitizePolicyHtml(`<a href="${href}">l</a>`);
      expect(out).not.toMatch(/javascript|vbscript/i);
      expect(out).not.toContain('href');
      expect(out).toContain('>l</a>');
    }
  });

  it('removes data: urls from href and src', () => {
    expect(sanitizePolicyHtml('<a href="data:text/html,x">l</a>')).not.toContain('data:');
    expect(sanitizePolicyHtml('<img src="data:image/svg+xml,x" alt="i">')).not.toContain('data:');
  });

  it('keeps http, https, mailto, tel and relative links', () => {
    for (const href of ['http://a.test/', 'https://a.test/', 'mailto:a@a.test', 'tel:+123', '/terms', '#top', 'x/y']) {
      expect(sanitizePolicyHtml(`<a href="${href}">l</a>`)).toContain(`href="${href}"`);
    }
  });

  it('forces rel and target on links', () => {
    const out = sanitizePolicyHtml('<a href="https://a.test" rel="opener" target="_self">l</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain('opener"');
  });

  it('keeps unknown tags as their text and safe children', () => {
    expect(sanitizePolicyHtml('<p><blink>hi <b>there</b></blink></p>')).toBe('<p>hi <b>there</b></p>');
  });

  it('keeps real policy structure', () => {
    const html = '<h2>T</h2><ul><li>a</li></ul><table><tbody><tr><td colspan="2">c</td></tr></tbody></table><pre><code>x</code></pre><blockquote>q</blockquote><hr>';
    expect(sanitizePolicyHtml(html)).toBe(html);
  });

  it('escapes text so a serialised string cannot re-open markup', () => {
    const out = sanitizePolicyHtml('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(out).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });

  it('builds the fragment in the target document', () => {
    const frag = sanitizePolicyFragment('<p>a</p>', document);
    expect(frag.ownerDocument).toBe(document);
    expect(frag.querySelector('p')?.textContent).toBe('a');
    expect(renderPolicyFragment({ contentHtml: null, contentMarkdown: '# h' }, document).querySelector('h1')?.textContent).toBe('h');
  });
});
