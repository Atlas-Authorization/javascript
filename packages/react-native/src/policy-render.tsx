import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import {
  formatPolicyDate,
  joinTitles,
  policyHtml,
  splitTemplate,
  type Policy,
  type PolicyAcceptanceController,
  type PolicyT,
} from '@atlasauth/js';
import { parsePolicyHtml, type PolicyBlock, type PolicySpan } from './policy-html';

/*
 * The element builders behind the native policy components. They are plain
 * functions from a view-model to React elements over an injected set of
 * primitives, so they are unit-tested without a renderer (pass string element
 * types and read the tree) and so `policy-ui.tsx`, the only file that imports
 * `react-native`, stays a thin layer of hooks.
 */

type Any = ComponentType<any> | string;

/** The `react-native` components the policy UI draws with. */
export interface PolicyPrimitives {
  View: Any;
  Text: Any;
  Pressable: Any;
  ScrollView: Any;
  Modal: Any;
}

/** Appearance hooks: `style` objects merged over the defaults. */
export interface PolicyStyles {
  root?: object;
  text?: object;
  link?: object;
  button?: object;
  primaryButton?: object;
  error?: object;
}

/** Whether a vertical scroller has reached its end (also true when the content fits). */
export function isScrolledToEnd(
  m: { layoutHeight: number; contentHeight: number; offsetY: number },
  slack = 2,
): boolean {
  if (m.layoutHeight <= 0 || m.contentHeight <= 0) return false;
  return m.contentHeight - m.layoutHeight - m.offsetY <= slack;
}

const meta = (policy: Policy, t: PolicyT): string => {
  const parts: string[] = [];
  if (policy.version) parts.push(t('policy.version', { version: policy.version }));
  const date = formatPolicyDate(policy.effectiveAt);
  if (date) parts.push(t('policy.effective', { date }));
  return parts.join(' · ');
};

const el = (type: Any, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement =>
  createElement(type as never, props as never, ...children);

/** One document span as nested text. */
function spanElement(ui: PolicyPrimitives, s: PolicySpan, key: number, onLink: (href: string) => void, styles: PolicyStyles): ReactElement {
  const style = [
    s.bold ? { fontWeight: '700' } : null,
    s.italic ? { fontStyle: 'italic' } : null,
    s.code ? { fontFamily: 'monospace' } : null,
    s.href ? { textDecorationLine: 'underline', color: '#5b5bd6' } : null,
    s.href ? styles.link : null,
  ].filter(Boolean);
  return el(
    ui.Text,
    {
      key,
      style,
      ...(s.href
        ? { onPress: () => onLink(s.href!), accessibilityRole: 'link', accessibilityHint: s.href }
        : {}),
    },
    s.text,
  );
}

/** A policy document drawn natively from its sanitised HTML. */
export function renderPolicyDocument(
  ui: PolicyPrimitives,
  html: string,
  onLink: (href: string) => void,
  styles: PolicyStyles = {},
): ReactElement {
  const blocks = parsePolicyHtml(html);
  return el(
    ui.View,
    { testID: 'atlas.policy_document', style: { gap: 8 } },
    ...blocks.map((b, i) => blockElement(ui, b, i, onLink, styles)),
  );
}

function blockElement(ui: PolicyPrimitives, b: PolicyBlock, key: number, onLink: (href: string) => void, styles: PolicyStyles): ReactElement {
  if (b.kind === 'rule') {
    return el(ui.View, { key, style: { height: 1, backgroundColor: '#e4e4e9', marginVertical: 4 } });
  }
  const heading = b.kind === 'heading';
  const fontSize = heading ? [0, 22, 19, 17, 16, 15, 14][b.level] ?? 16 : 15;
  const text = el(
    ui.Text,
    {
      style: [
        { fontSize, lineHeight: Math.round(fontSize * 1.45) },
        heading ? { fontWeight: '600' } : null,
        b.kind === 'quote' ? { fontStyle: 'italic' } : null,
        styles.text,
      ].filter(Boolean),
      accessibilityRole: heading ? 'header' : undefined,
    },
    ...b.spans.map((s, i) => spanElement(ui, s, i, onLink, styles)),
  );
  const indent = b.depth * 16 + (b.kind === 'quote' ? 12 : 0);
  if (!b.marker) return el(ui.View, { key, style: { paddingLeft: indent } }, text);
  return el(
    ui.View,
    { key, style: { flexDirection: 'row', paddingLeft: indent } },
    el(ui.Text, { style: [{ fontSize, marginRight: 6 }, styles.text].filter(Boolean) }, b.marker),
    el(ui.View, { style: { flex: 1 } }, text),
  );
}

/** A sentence with each policy title tappable: `onTitle` gets the policy key. */
export function renderPolicySentence(
  ui: PolicyPrimitives,
  template: string,
  policies: Policy[],
  t: PolicyT,
  onTitle: (key: string) => void,
  styles: PolicyStyles = {},
  testID = 'atlas.policy_sentence',
): ReactElement {
  const name = template.includes('{policies}') ? 'policies' : 'policy';
  const [before, after] = splitTemplate(template, name);
  const children: ReactNode[] = [before];
  policies.forEach((p, i) => {
    if (i > 0) children.push(i === policies.length - 1 ? ` ${t('policy.and')} ` : ', ');
    children.push(
      el(
        ui.Text,
        {
          key: p.key,
          testID: `atlas.policy_link.${p.key}`,
          onPress: () => onTitle(p.key),
          accessibilityRole: 'link',
          style: [{ color: '#5b5bd6', textDecorationLine: 'underline' }, styles.link].filter(Boolean),
        },
        p.title,
      ),
    );
  });
  children.push(after);
  return el(ui.Text, { testID, style: [{ fontSize: 14 }, styles.text].filter(Boolean) }, ...children);
}

/** The checkbox row: a pressable box and a label. */
function checkboxRow(
  ui: PolicyPrimitives,
  testID: string,
  checked: boolean,
  onToggle: () => void,
  label: ReactElement,
  accessibilityLabel: string,
): ReactElement {
  return el(
    ui.View,
    { key: testID, style: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 } },
    el(
      ui.Pressable,
      {
        testID,
        onPress: onToggle,
        accessibilityRole: 'checkbox',
        accessibilityState: { checked },
        accessibilityLabel,
        hitSlop: 8,
        style: {
          width: 22,
          height: 22,
          marginTop: 1,
          borderWidth: 2,
          borderRadius: 4,
          borderColor: '#5b5bd6',
          backgroundColor: checked ? '#5b5bd6' : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      checked ? el(ui.Text, { style: { color: '#fff', fontSize: 14, lineHeight: 16 } }, '✓') : null,
    ),
    el(ui.View, { style: { flex: 1 } }, label),
  );
}

/** The consent block: a combined checkbox, or one per checkbox-mode policy. */
export function renderPolicyConsent(
  ui: PolicyPrimitives,
  controller: PolicyAcceptanceController,
  t: PolicyT,
  styles: PolicyStyles = {},
): ReactElement | null {
  const boxes = controller.checkboxPolicies();
  if (boxes.length === 0) return null;
  if (controller.combined) {
    const checked = controller.snapshot().combinedChecked;
    const plain = t('policy.agreeCombined', { policies: joinTitles(boxes.map((p) => p.title), t('policy.and')) });
    return el(
      ui.View,
      { testID: 'atlas.policy_consent', style: [{ gap: 10 }, styles.root].filter(Boolean) },
      checkboxRow(
        ui,
        'atlas.policy_consent.all',
        checked,
        () => controller.setAllChecked(!checked),
        renderPolicySentence(ui, t('policy.agreeCombined'), boxes, t, (k) => controller.openDocument(k), styles),
        plain,
      ),
    );
  }
  return el(
    ui.View,
    { testID: 'atlas.policy_consent', style: [{ gap: 10 }, styles.root].filter(Boolean) },
    ...boxes.map((p) => {
      const checked = controller.isChecked(p.key);
      return checkboxRow(
        ui,
        `atlas.policy_consent.${p.key}`,
        checked,
        () => controller.setChecked(p.key, !checked),
        renderPolicySentence(ui, t('policy.agreeOne'), [p], t, (k) => controller.openDocument(k), styles),
        t('policy.agreeOne', { policy: p.title }),
      );
    }),
  );
}

/** The clickwrap sentence for `link` policies (submitting accepts), or null when there are none. */
export function renderPolicyClickwrap(
  ui: PolicyPrimitives,
  controller: PolicyAcceptanceController,
  t: PolicyT,
  styles: PolicyStyles = {},
): ReactElement | null {
  const links = controller.linkPolicies();
  if (links.length === 0) return null;
  return renderPolicySentence(ui, t('policy.clickwrap'), links, t, (k) => controller.openDocument(k), styles, 'atlas.policy_clickwrap');
}

/** The in-app document viewer (a full-screen modal) for the document `controller` has open, or null. */
export function renderPolicyViewer(
  ui: PolicyPrimitives,
  controller: PolicyAcceptanceController,
  t: PolicyT,
  onLink: (href: string) => void,
  handlers: ScrollHandlers,
  styles: PolicyStyles = {},
): ReactElement | null {
  const policy = controller.viewing;
  if (!policy) return null;
  const header = meta(policy, t);
  return el(
    ui.Modal,
    {
      key: 'viewer',
      testID: 'atlas.policy_viewer',
      visible: true,
      animationType: 'slide',
      onRequestClose: () => controller.closeDocument(),
    },
    el(
      ui.View,
      { style: [{ flex: 1, padding: 16, paddingTop: 48, backgroundColor: '#fff' }, styles.root].filter(Boolean) },
      el(
        ui.Pressable,
        { testID: 'atlas.policy_viewer_back', onPress: () => controller.closeDocument(), accessibilityRole: 'button', style: { paddingVertical: 8 } },
        el(ui.Text, { style: [{ color: '#5b5bd6', fontSize: 16 }, styles.link].filter(Boolean) }, `‹ ${t('policy.viewerBack')}`),
      ),
      el(ui.Text, { accessibilityRole: 'header', style: { fontSize: 22, fontWeight: '600' } }, policy.title),
      header ? el(ui.Text, { style: { fontSize: 12, color: '#666', marginBottom: 8 } }, header) : null,
      el(
        ui.ScrollView,
        {
          testID: 'atlas.policy_viewer_scroll',
          style: { flex: 1 },
          scrollEventThrottle: 16,
          onScroll: handlers.onScroll,
          onLayout: handlers.onLayout,
          onContentSizeChange: handlers.onContentSizeChange,
        },
        renderPolicyDocument(ui, policyHtml(policy), onLink, styles),
      ),
    ),
  );
}

/** What React Native's `onScroll` hands over (the part we read). */
export interface ScrollEvent {
  nativeEvent: {
    layoutMeasurement: { height: number };
    contentSize: { height: number };
    contentOffset: { y: number };
  };
}

/** The three scroll callbacks a `ScrollView` needs for end detection. */
export interface ScrollHandlers {
  onScroll: (e: ScrollEvent) => void;
  onLayout: (e: { nativeEvent: { layout: { height: number } } }) => void;
  onContentSizeChange: (w: number, h: number) => void;
}

/**
 * Tells you once, when a `ScrollView` has shown its end: from scrolling, or at
 * once when the content fits its box (layout and content size alone decide).
 */
export class ScrollEndTracker implements ScrollHandlers {
  private layoutHeight = 0;
  private contentHeight = 0;
  private offsetY = 0;
  private fired = false;

  constructor(private readonly onEnd: () => void) {}

  /** Whether the end has been seen. */
  get reached(): boolean {
    return this.fired;
  }

  private check(): void {
    if (this.fired) return;
    if (isScrolledToEnd({ layoutHeight: this.layoutHeight, contentHeight: this.contentHeight, offsetY: this.offsetY })) {
      this.fired = true;
      this.onEnd();
    }
  }

  onScroll = (e: ScrollEvent): void => {
    const n = e.nativeEvent;
    this.layoutHeight = n.layoutMeasurement.height;
    this.contentHeight = n.contentSize.height;
    this.offsetY = n.contentOffset.y;
    this.check();
  };

  onLayout = (e: { nativeEvent: { layout: { height: number } } }): void => {
    this.layoutHeight = e.nativeEvent.layout.height;
    this.check();
  };

  onContentSizeChange = (_w: number, h: number): void => {
    this.contentHeight = h;
    this.check();
  };
}

/**
 * The unskippable dialog for one `scroll` policy: a modal with no way out but its
 * buttons (the hardware back button is swallowed), Accept enabled only once the
 * end has been seen (or the text fits), Decline cancels. For a re-acceptance it
 * shows what changed.
 */
export function renderPolicyScrollModal(
  ui: PolicyPrimitives,
  policy: Policy,
  state: { atEnd: boolean },
  t: PolicyT,
  handlers: ScrollHandlers & {
    onAccept: () => void;
    onDecline: () => void;
    onLink: (href: string) => void;
  },
  styles: PolicyStyles = {},
): ReactElement {
  const title = policy.reaccept === true ? t('policy.reacceptTitle', { policy: policy.title }) : policy.title;
  const header = meta(policy, t);
  return el(
    ui.Modal,
    {
      testID: 'atlas.policy_dialog',
      visible: true,
      animationType: 'slide',
      // The hardware back button must not dismiss it.
      onRequestClose: () => undefined,
    },
    el(
      ui.View,
      {
        accessibilityViewIsModal: true,
        style: [{ flex: 1, padding: 16, paddingTop: 48, backgroundColor: '#fff', gap: 8 }, styles.root].filter(Boolean),
      },
      el(ui.Text, { accessibilityRole: 'header', style: { fontSize: 22, fontWeight: '600' } }, title),
      header ? el(ui.Text, { style: { fontSize: 12, color: '#666' } }, header) : null,
      policy.reaccept === true && policy.summaryOfChanges
        ? el(
            ui.View,
            { testID: 'atlas.policy_summary', style: { padding: 10, borderRadius: 8, backgroundColor: '#f1f1fb' } },
            el(ui.Text, { style: { fontWeight: '600' } }, t('policy.summaryTitle')),
            el(ui.Text, null, policy.summaryOfChanges),
          )
        : null,
      el(
        ui.ScrollView,
        {
          testID: 'atlas.policy_scroll',
          style: { flex: 1 },
          scrollEventThrottle: 16,
          onScroll: handlers.onScroll,
          onLayout: handlers.onLayout,
          onContentSizeChange: handlers.onContentSizeChange,
        },
        renderPolicyDocument(ui, policyHtml(policy), handlers.onLink, styles),
      ),
      state.atEnd ? null : el(ui.Text, { testID: 'atlas.policy_hint', accessibilityLiveRegion: 'polite', style: { fontSize: 13, color: '#666' } }, t('policy.scrollHint')),
      el(
        ui.View,
        { style: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 } },
        el(
          ui.Pressable,
          { testID: 'atlas.policy_decline', onPress: handlers.onDecline, accessibilityRole: 'button', style: [{ padding: 12 }, styles.button].filter(Boolean) },
          el(ui.Text, { style: { fontSize: 16 } }, t('policy.decline')),
        ),
        el(
          ui.Pressable,
          {
            testID: 'atlas.policy_accept',
            onPress: state.atEnd ? handlers.onAccept : undefined,
            disabled: !state.atEnd,
            accessibilityRole: 'button',
            accessibilityState: { disabled: !state.atEnd },
            style: [
              { padding: 12, borderRadius: 8, backgroundColor: '#5b5bd6', opacity: state.atEnd ? 1 : 0.5 },
              styles.primaryButton,
            ].filter(Boolean),
          },
          el(ui.Text, { style: { fontSize: 16, color: '#fff', fontWeight: '600' } }, t('policy.accept')),
        ),
      ),
    ),
  );
}

/** The held-sign-in step: intro, what changed, consent, the continue button, clickwrap, decline. */
export function renderPolicyAcceptStep(
  ui: PolicyPrimitives,
  controller: PolicyAcceptanceController,
  t: PolicyT,
  state: { busy?: boolean; message?: string | null },
  handlers: { onSubmit: () => void; onDecline: () => void },
  styles: PolicyStyles = {},
): ReactElement {
  const changed = controller.policies.filter((p) => p.reaccept === true && p.summaryOfChanges);
  const enabled = !state.busy && controller.canSubmit();
  return el(
    ui.View,
    { testID: 'atlas.policy_step', style: [{ gap: 12 }, styles.root].filter(Boolean) },
    el(ui.Text, { accessibilityRole: 'header', style: { fontSize: 18, fontWeight: '600' } }, t('policy.pendingTitle')),
    el(ui.Text, { style: { fontSize: 14 } }, t('policy.pendingIntro')),
    ...changed.map((p) => el(ui.Text, { key: p.key, style: { fontSize: 12 } }, `${p.title}: ${p.summaryOfChanges}`)),
    renderPolicyConsent(ui, controller, t, styles),
    el(
      ui.Pressable,
      {
        testID: 'atlas.policy_submit',
        onPress: enabled ? handlers.onSubmit : undefined,
        disabled: !enabled,
        accessibilityRole: 'button',
        accessibilityState: { disabled: !enabled },
        style: [
          { padding: 14, borderRadius: 8, alignItems: 'center', backgroundColor: '#5b5bd6', opacity: enabled ? 1 : 0.5 },
          styles.primaryButton,
        ].filter(Boolean),
      },
      el(ui.Text, { style: { color: '#fff', fontSize: 16, fontWeight: '600' } }, t('policy.submit')),
    ),
    renderPolicyClickwrap(ui, controller, t, styles),
    el(
      ui.Pressable,
      { testID: 'atlas.policy_step_decline', onPress: state.busy ? undefined : handlers.onDecline, accessibilityRole: 'button', style: { padding: 10, alignItems: 'center' } },
      el(ui.Text, { style: [{ fontSize: 15 }, styles.link].filter(Boolean) }, t('policy.decline')),
    ),
    state.message ? el(ui.Text, { testID: 'atlas.policy_message', style: [{ color: '#c62828', fontSize: 13 }, styles.error].filter(Boolean) }, state.message) : null,
  );
}

/** The re-acceptance banner for a signed-in user. */
export function renderPolicyBanner(
  ui: PolicyPrimitives,
  titles: string[],
  graceEndsAt: string | null,
  t: PolicyT,
  handlers: { onReview: () => void },
  state: { busy?: boolean; error?: string | null } = {},
  styles: PolicyStyles = {},
): ReactElement {
  return el(
    ui.View,
    { testID: 'atlas.policy_gate', accessibilityRole: 'alert', style: [{ padding: 12, borderRadius: 8, backgroundColor: '#f1f1fb', gap: 4 }, styles.root].filter(Boolean) },
    el(ui.Text, { style: { fontWeight: '600' } }, t('policy.bannerTitle')),
    el(ui.Text, null, t('policy.bannerBody', { policies: joinTitles(titles, t('policy.and')) })),
    graceEndsAt ? el(ui.Text, { style: { fontSize: 12 } }, t('policy.bannerGrace', { date: formatPolicyDate(graceEndsAt) })) : null,
    state.error ? el(ui.Text, { style: [{ color: '#c62828' }, styles.error].filter(Boolean) }, state.error) : null,
    el(
      ui.Pressable,
      { testID: 'atlas.policy_gate_review', onPress: state.busy ? undefined : handlers.onReview, disabled: !!state.busy, accessibilityRole: 'button', style: { paddingVertical: 8 } },
      el(ui.Text, { style: [{ color: '#5b5bd6', fontSize: 15 }, styles.link].filter(Boolean) }, t('policy.bannerReview')),
    ),
  );
}
