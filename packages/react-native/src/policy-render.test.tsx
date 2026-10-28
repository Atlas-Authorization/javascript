import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  PolicyAcceptanceController,
  normalizePolicy,
  policyTranslator,
  type Policy,
} from '@atlasauth/js';
import {
  ScrollEndTracker,
  isScrolledToEnd,
  renderPolicyAcceptStep,
  renderPolicyBanner,
  renderPolicyClickwrap,
  renderPolicyConsent,
  renderPolicyDocument,
  renderPolicyScrollModal,
  renderPolicyViewer,
  type PolicyPrimitives,
} from './policy-render';

/**
 * The native policy UI is built by pure functions over injected primitives, so
 * the element trees are asserted here without a renderer (the primitives are
 * plain strings). On-device rendering is verified in app QA, not here.
 */

const ui: PolicyPrimitives = {
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Modal: 'Modal',
};
const t = policyTranslator(() => '');

function policy(key: string, extra: Record<string, unknown> = {}): Policy {
  return normalizePolicy({
    key,
    title: key.toUpperCase(),
    display: 'checkbox',
    required: true,
    version_id: `polv_${key}`,
    version: '1',
    content_html: '<p>Body text</p>',
    content_sha256: `sha_${key}`,
    ...extra,
  })!;
}

type Props = Record<string, any>;

function walk(node: ReactNode, visit: (el: ReactElement<Props>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!isValidElement(node)) return;
  const el = node as ReactElement<Props>;
  visit(el);
  walk(el.props.children, visit);
}

function find(node: ReactNode, testID: string): ReactElement<Props> | undefined {
  let found: ReactElement<Props> | undefined;
  walk(node, (el) => {
    if (!found && el.props.testID === testID) found = el;
  });
  return found;
}

function texts(node: ReactNode): string {
  let out = '';
  const rec = (n: ReactNode): void => {
    if (typeof n === 'string' || typeof n === 'number') out += n;
    else if (Array.isArray(n)) n.forEach(rec);
    else if (isValidElement(n)) rec((n as ReactElement<Props>).props.children);
  };
  rec(node);
  return out;
}

describe('consent', () => {
  it('draws one combined checkbox and ticks every checkbox policy', () => {
    const c = new PolicyAcceptanceController([policy('tos'), policy('privacy')]);
    const tree = renderPolicyConsent(ui, c, t)!;
    const box = find(tree, 'atlas.policy_consent.all')!;
    expect(box.props.accessibilityRole).toBe('checkbox');
    expect(box.props.accessibilityState).toEqual({ checked: false });
    expect(texts(find(tree, 'atlas.policy_sentence'))).toBe('I agree to the TOS and PRIVACY');
    box.props.onPress();
    expect(c.canSubmit()).toBe(true);
    expect(renderPolicyConsent(ui, c, t) && find(renderPolicyConsent(ui, c, t), 'atlas.policy_consent.all')!.props.accessibilityState).toEqual({ checked: true });
  });

  it('a title opens the document in the viewer', () => {
    const c = new PolicyAcceptanceController([policy('tos'), policy('privacy')]);
    find(renderPolicyConsent(ui, c, t)!, 'atlas.policy_link.privacy')!.props.onPress();
    expect(c.viewing?.key).toBe('privacy');
    const onLink = vi.fn();
    const scroll = { onScroll: vi.fn(), onLayout: vi.fn(), onContentSizeChange: vi.fn() };
    const viewer = renderPolicyViewer(ui, c, t, onLink, scroll)!;
    expect(viewer.props.visible).toBe(true);
    expect(texts(viewer)).toContain('PRIVACY');
    expect(texts(viewer)).toContain('Body text');
    find(viewer, 'atlas.policy_viewer_back')!.props.onPress();
    expect(c.viewing).toBeNull();
    expect(renderPolicyViewer(ui, c, t, onLink, scroll)).toBeNull();
  });

  it('separate mode draws one box per policy', () => {
    const c = new PolicyAcceptanceController([policy('tos'), policy('privacy')], { combined: false });
    const tree = renderPolicyConsent(ui, c, t)!;
    find(tree, 'atlas.policy_consent.tos')!.props.onPress();
    expect(c.isChecked('tos')).toBe(true);
    expect(c.isChecked('privacy')).toBe(false);
    expect(find(tree, 'atlas.policy_consent.privacy')).toBeDefined();
  });

  it('draws nothing without checkbox policies; clickwrap only for link policies', () => {
    const none = new PolicyAcceptanceController([policy('cookies', { display: 'link' })]);
    expect(renderPolicyConsent(ui, none, t)).toBeNull();
    const wrap = renderPolicyClickwrap(ui, none, t)!;
    expect(texts(wrap)).toBe('By continuing you agree to the COOKIES.');
    expect(renderPolicyClickwrap(ui, new PolicyAcceptanceController([policy('tos')]), t)).toBeNull();
  });
});

describe('scroll modal', () => {
  const handlers = () => ({
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onScroll: vi.fn(),
    onLayout: vi.fn(),
    onContentSizeChange: vi.fn(),
    onLink: vi.fn(),
  });

  it('cannot be dismissed and keeps Accept off until the end', () => {
    const p = policy('tos', { display: 'scroll' });
    const h = handlers();
    const before = renderPolicyScrollModal(ui, p, { atEnd: false }, t, h);
    // The hardware back button does nothing.
    expect(before.props.onRequestClose()).toBeUndefined();
    const accept = find(before, 'atlas.policy_accept')!;
    expect(accept.props.disabled).toBe(true);
    expect(accept.props.onPress).toBeUndefined();
    expect(texts(find(before, 'atlas.policy_hint'))).toBe('Scroll to the end to accept');

    const after = renderPolicyScrollModal(ui, p, { atEnd: true }, t, h);
    expect(find(after, 'atlas.policy_hint')).toBeUndefined();
    const enabled = find(after, 'atlas.policy_accept')!;
    expect(enabled.props.disabled).toBe(false);
    enabled.props.onPress();
    expect(h.onAccept).toHaveBeenCalledOnce();
    find(after, 'atlas.policy_decline')!.props.onPress();
    expect(h.onDecline).toHaveBeenCalledOnce();
  });

  it('shows what changed for a re-acceptance', () => {
    const p = policy('tos', { display: 'scroll', reaccept: true, summary_of_changes: 'New arbitration clause' });
    const tree = renderPolicyScrollModal(ui, p, { atEnd: false }, t, handlers());
    expect(texts(find(tree, 'atlas.policy_summary'))).toBe('What changedNew arbitration clause');
    expect(texts(tree)).toContain('TOS has been updated');
  });

  it('wires the scroll handlers onto the ScrollView', () => {
    const h = handlers();
    const scroll = find(renderPolicyScrollModal(ui, policy('tos'), { atEnd: false }, t, h), 'atlas.policy_scroll')!;
    expect(scroll.props.onScroll).toBe(h.onScroll);
    expect(scroll.props.onLayout).toBe(h.onLayout);
    expect(scroll.props.onContentSizeChange).toBe(h.onContentSizeChange);
  });
});

describe('end detection', () => {
  it('isScrolledToEnd needs real measurements and a small slack', () => {
    expect(isScrolledToEnd({ layoutHeight: 0, contentHeight: 0, offsetY: 0 })).toBe(false);
    expect(isScrolledToEnd({ layoutHeight: 400, contentHeight: 300, offsetY: 0 })).toBe(true); // fits
    expect(isScrolledToEnd({ layoutHeight: 400, contentHeight: 1000, offsetY: 100 })).toBe(false);
    expect(isScrolledToEnd({ layoutHeight: 400, contentHeight: 1000, offsetY: 599 })).toBe(true);
  });

  it('the tracker fires once, from scrolling', () => {
    const end = vi.fn();
    const tr = new ScrollEndTracker(end);
    const ev = (y: number) => ({
      nativeEvent: { layoutMeasurement: { height: 400 }, contentSize: { height: 1000 }, contentOffset: { y } },
    });
    tr.onScroll(ev(0));
    expect(end).not.toHaveBeenCalled();
    tr.onScroll(ev(600));
    tr.onScroll(ev(600));
    expect(end).toHaveBeenCalledOnce();
    expect(tr.reached).toBe(true);
  });

  it('the tracker fires at once when the content fits (layout + content size)', () => {
    const end = vi.fn();
    const tr = new ScrollEndTracker(end);
    tr.onLayout({ nativeEvent: { layout: { height: 500 } } });
    expect(end).not.toHaveBeenCalled();
    tr.onContentSizeChange(300, 120);
    expect(end).toHaveBeenCalledOnce();
  });
});

describe('accept step', () => {
  it('keeps the continue button off until the required boxes are ticked, then submits', () => {
    const c = new PolicyAcceptanceController([policy('tos')]);
    const onSubmit = vi.fn();
    const onDecline = vi.fn();
    const off = renderPolicyAcceptStep(ui, c, t, {}, { onSubmit, onDecline });
    expect(find(off, 'atlas.policy_submit')!.props.disabled).toBe(true);
    c.setAllChecked(true);
    const on = renderPolicyAcceptStep(ui, c, t, {}, { onSubmit, onDecline });
    const btn = find(on, 'atlas.policy_submit')!;
    expect(btn.props.disabled).toBe(false);
    btn.props.onPress();
    expect(onSubmit).toHaveBeenCalledOnce();
    find(on, 'atlas.policy_step_decline')!.props.onPress();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('is disabled while busy and shows a message', () => {
    const c = new PolicyAcceptanceController([policy('tos')]);
    c.setAllChecked(true);
    const tree = renderPolicyAcceptStep(ui, c, t, { busy: true, message: 'You need to accept the TOS to use this app.' }, { onSubmit: vi.fn(), onDecline: vi.fn() });
    expect(find(tree, 'atlas.policy_submit')!.props.disabled).toBe(true);
    expect(texts(find(tree, 'atlas.policy_message'))).toBe('You need to accept the TOS to use this app.');
  });

  it('lists what changed for re-accepted policies', () => {
    const c = new PolicyAcceptanceController([policy('tos', { reaccept: true, summary_of_changes: 'New clause' })]);
    const tree = renderPolicyAcceptStep(ui, c, t, {}, { onSubmit: vi.fn(), onDecline: vi.fn() });
    expect(texts(tree)).toContain('TOS: New clause');
  });
});

describe('banner', () => {
  it('names the policies, the grace date and wires Review', () => {
    const onReview = vi.fn();
    const tree = renderPolicyBanner(ui, ['Terms', 'Privacy'], '2026-10-24T00:00:00.000Z', t, { onReview });
    expect(texts(tree)).toContain('We have updated: Terms and Privacy. Please review and accept.');
    expect(texts(tree)).toContain('Accept by 2026-10-24 to keep your access.');
    find(tree, 'atlas.policy_gate_review')!.props.onPress();
    expect(onReview).toHaveBeenCalledOnce();
  });
});

describe('document', () => {
  it('draws links as pressable text and routes them to onLink', () => {
    const onLink = vi.fn();
    const tree = renderPolicyDocument(ui, '<p>See <a href="https://x.test/p">the page</a>.</p><script>x</script>', onLink);
    let link: ReactElement<Props> | undefined;
    walk(tree, (el) => {
      if (el.props.accessibilityRole === 'link') link = el;
    });
    expect(link).toBeDefined();
    link!.props.onPress();
    expect(onLink).toHaveBeenCalledWith('https://x.test/p');
    expect(texts(tree)).toBe('See the page.');
  });
});
