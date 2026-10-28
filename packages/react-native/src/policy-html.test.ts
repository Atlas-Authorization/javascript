import { describe, expect, it } from 'vitest';
import { markdownToSafeHtml } from '@atlasauth/js';
import { parsePolicyHtml, policyPlainText } from './policy-html';

describe('parsePolicyHtml', () => {
  it('reads blocks, spans and lists', () => {
    const blocks = parsePolicyHtml(
      '<h1>Terms</h1><p>Hello <strong>bold</strong> and <em>soft</em> <a href="https://x.test/a">link</a>.</p>' +
        '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
    );
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[0]!.spans[0]!.text).toBe('Terms');
    const p = blocks[1]!;
    expect(p.spans.map((s) => s.text).join('')).toBe('Hello bold and soft link.');
    expect(p.spans.find((s) => s.bold)?.text).toBe('bold');
    expect(p.spans.find((s) => s.italic)?.text).toBe('soft');
    expect(p.spans.find((s) => s.href)?.href).toBe('https://x.test/a');
    expect(blocks.filter((b) => b.kind === 'list_item').map((b) => b.marker)).toEqual(['•', '•', '1.', '2.']);
  });

  it('drops unsafe links and active content', () => {
    const blocks = parsePolicyHtml('<p><a href="javascript:alert(1)">bad</a><script>alert(1)</script><style>p{}</style> ok</p>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.spans.map((s) => s.text).join('')).toBe('bad ok');
    expect(blocks[0]!.spans.some((s) => s.href)).toBe(false);
  });

  it('decodes entities and collapses whitespace', () => {
    expect(policyPlainText('<p>A &amp;\n  B &lt;c&gt; &ldquo;q&rdquo; &#233; &#x1F600;</p>')).toBe('A & B <c> “q” é \u{1F600}');
  });

  it('indents nested lists; rules and quotes become blocks', () => {
    const blocks = parsePolicyHtml('<ul><li>a<ul><li>b</li></ul></li></ul><hr><blockquote><p>quoted</p></blockquote>');
    expect(blocks.filter((b) => b.kind === 'list_item').map((b) => b.depth)).toEqual([0, 1]);
    expect(blocks.some((b) => b.kind === 'rule')).toBe(true);
    expect(blocks[blocks.length - 1]!.kind).toBe('quote');
  });

  it('treats unknown tags as transparent and stray angle brackets as text', () => {
    expect(policyPlainText('<section><blink>keep</blink> this</section>')).toBe('keep this');
    expect(policyPlainText('<p>1 < 2')).toBe('1 < 2');
    expect(policyPlainText('')).toBe('');
  });

  it('reads the markdown fallback the shared renderer produces, escaped', () => {
    const html = markdownToSafeHtml('# Title\n\nHi <script>x</script> **b**\n\n- one\n- two');
    expect(policyPlainText(html)).toBe('Title\nHi <script>x</script> b\n• one\n• two');
  });
});
