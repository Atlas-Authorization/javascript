/**
 * §bot — client-side signal collection for the anti-bot pipeline.
 *
 * Two collectors, both privacy-preserving and both fully best-effort (they never
 * throw, and degrade to nulls in any environment):
 *
 *   - `collectDeviceSignals()` — a snapshot of the device/environment: screen,
 *     timezone, hardware, a coarse canvas/WebGL fingerprint, and AUTOMATION
 *     TELLS (navigator.webdriver, headless markers, Selenium/Puppeteer traces).
 *   - `BehaviorRecorder` — accumulates interaction TIMING AGGREGATES on the auth
 *     form: mouse kinematics, keystroke dwell/flight, time-to-submit, scrolls.
 *     It records COUNTS AND TIMINGS ONLY — never which keys were pressed, never
 *     field values. There is nothing sensitive to leak.
 *
 * `sendTelemetry()` posts a snapshot to `/v1/client/telemetry`. It is
 * fire-and-forget: a failure resolves `false` and is swallowed, so telemetry can
 * never interfere with a real sign-in.
 */

const hasWindow = typeof window !== 'undefined';
const nav = (): Navigator | undefined => (typeof navigator !== 'undefined' ? navigator : undefined);

// ---- device signals --------------------------------------------------------

export interface DeviceSignals {
  screenWidth: number | null;
  screenHeight: number | null;
  colorDepth: number | null;
  pixelRatio: number | null;
  timezone: string | null;
  timezoneOffset: number | null;
  language: string | null;
  languages: string[];
  platform: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  maxTouchPoints: number | null;
  touchSupport: boolean;
  cookieEnabled: boolean | null;
  doNotTrack: boolean | null;
  webglVendor: string | null;
  webglRenderer: string | null;
  pluginCount: number | null;
  pointerType: string | null;
  webdriver: boolean;
  headless: boolean;
  hasChrome: boolean;
  webglSoftware: boolean;
  automationHint: boolean;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** WebGL unmasked vendor/renderer, if exposed. */
function webglInfo(): { vendor: string | null; renderer: string | null } {
  return safe(() => {
    if (!hasWindow || typeof document === 'undefined') return { vendor: null, renderer: null };
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: null, renderer: null };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = ext ? (gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string) : null;
    const renderer = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : null;
    return { vendor: vendor ?? null, renderer: renderer ?? null };
  }, { vendor: null, renderer: null });
}

/** A short non-crypto canvas fingerprint (a bucket key, never a credential). */
function canvasHash(): string | null {
  return safe(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 60, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Atlas anti-bot ✈ 1.0', 2, 15);
    return djb2(canvas.toDataURL());
  }, null);
}

/** Detect common headless/automation markers without being fooled by UA alone. */
function automationTells(): { webdriver: boolean; headless: boolean; hasChrome: boolean; automationHint: boolean } {
  const n = nav();
  const w = hasWindow ? (window as unknown as Record<string, unknown>) : {};
  const ua = n?.userAgent ?? '';
  const webdriver = safe(() => n?.webdriver === true, false);
  const hasChrome = safe(() => 'chrome' in w && !!w.chrome, false);
  const headless =
    /headless/i.test(ua) ||
    // A Chrome UA with no chrome object and no plugins is a classic headless tell.
    (/chrome/i.test(ua) && !hasChrome && safe(() => (n?.plugins?.length ?? 0) === 0, false));
  const automationHint = safe(
    () =>
      webdriver ||
      '_phantom' in w ||
      'callPhantom' in w ||
      '__nightmare' in w ||
      'domAutomation' in w ||
      'domAutomationController' in w ||
      // chromedriver injects cdc_* properties on document.
      (typeof document !== 'undefined' &&
        Object.keys(document).some((k) => k.startsWith('cdc_') || k.startsWith('$cdc_'))) ||
      /electron|phantomjs|slimerjs/i.test(ua),
    webdriver,
  );
  return { webdriver, headless, hasChrome, automationHint };
}

export function collectDeviceSignals(): DeviceSignals {
  const n = nav();
  const gl = webglInfo();
  const tells = automationTells();
  const languages = safe(() => Array.from(n?.languages ?? []), [] as string[]);
  const renderer = gl.renderer;
  return {
    screenWidth: safe(() => window.screen?.width ?? null, null),
    screenHeight: safe(() => window.screen?.height ?? null, null),
    colorDepth: safe(() => window.screen?.colorDepth ?? null, null),
    pixelRatio: safe(() => window.devicePixelRatio ?? null, null),
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null, null),
    timezoneOffset: safe(() => new Date().getTimezoneOffset(), null),
    language: safe(() => n?.language ?? null, null),
    languages,
    platform: safe(() => n?.platform ?? null, null),
    hardwareConcurrency: safe(() => n?.hardwareConcurrency ?? null, null),
    deviceMemory: safe(() => (n as unknown as { deviceMemory?: number })?.deviceMemory ?? null, null),
    maxTouchPoints: safe(() => n?.maxTouchPoints ?? null, null),
    touchSupport: safe(() => (n?.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window, false),
    cookieEnabled: safe(() => n?.cookieEnabled ?? null, null),
    doNotTrack: safe(() => n?.doNotTrack === '1' || (n as unknown as { doNotTrack?: string })?.doNotTrack === 'yes', null),
    webglVendor: gl.vendor,
    webglRenderer: renderer,
    pluginCount: safe(() => n?.plugins?.length ?? null, null),
    pointerType: safe(() => (window.matchMedia?.('(pointer: fine)')?.matches ? 'fine' : 'coarse'), null),
    webdriver: tells.webdriver,
    headless: tells.headless,
    hasChrome: tells.hasChrome,
    webglSoftware: renderer ? /swiftshader|llvmpipe|software|basic render/i.test(renderer) : false,
    automationHint: tells.automationHint,
    // canvasHash folds into the device fingerprint below; kept off the wire shape
    // to stay small, but influences deviceFingerprint().
  } as DeviceSignals;
}

/** A stable pseudonymous client id, persisted in localStorage. */
export function deviceId(): string | null {
  return safe(() => {
    if (typeof localStorage === 'undefined') return null;
    const KEY = '__atlas_did';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = 'd_' + djb2(String(Math.random()) + String(Date.now()) + (nav()?.userAgent ?? ''));
      localStorage.setItem(KEY, id);
    }
    return id;
  }, null);
}

/** A short client-side fingerprint over the stable device signals. */
export function deviceFingerprint(device: DeviceSignals): string {
  const parts = [
    device.timezone,
    device.platform,
    device.languages.join(','),
    device.webglVendor,
    device.webglRenderer,
    device.screenWidth,
    device.screenHeight,
    device.colorDepth,
    device.hardwareConcurrency,
    canvasHash(),
  ];
  return djb2(parts.map((p) => (p == null ? '' : String(p))).join('|'));
}

/** A tiny deterministic string hash (djb2) → 8-hex. Not a credential. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ---- behavioural recorder --------------------------------------------------

export interface BehaviorSignals {
  mouseMoves: number;
  mouseDistance: number;
  mouseAvgSpeed: number | null;
  mouseMaxSpeed: number;
  mouseSpeedVariance: number | null;
  mouseStraightLineRatio: number | null;
  keyCount: number;
  keyAvgDwellMs: number | null;
  keyAvgFlightMs: number | null;
  keyDwellVariance: number | null;
  keyFlightVariance: number | null;
  pasteCount: number;
  backspaceCount: number;
  timeToFirstInteractionMs: number | null;
  timeToSubmitMs: number | null;
  focusChanges: number;
  scrollCount: number;
  hadPointerMove: boolean;
  hadKeydown: boolean;
  interactionCount: number;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const variance = (xs: number[]): number | null => {
  const m = mean(xs);
  if (m === null) return null;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

/**
 * Records interaction TIMINGS on the page/form. Start it when the auth form
 * mounts; call `snapshot()` at submit. It listens passively and captures no
 * content — only counts, distances and millisecond timings.
 */
export class BehaviorRecorder {
  private readonly start = Date.now();
  private firstInteraction: number | null = null;
  private moves = 0;
  private distance = 0;
  private maxSpeed = 0;
  private speeds: number[] = [];
  private lastX: number | null = null;
  private lastY: number | null = null;
  private lastMoveT = 0;
  private netDx = 0;
  private netDy = 0;
  private keyCount = 0;
  private downAt = new Map<string, number>();
  private dwell: number[] = [];
  private flight: number[] = [];
  private lastUpAt: number | null = null;
  private pastes = 0;
  private backspaces = 0;
  private focusChanges = 0;
  private scrolls = 0;
  private target: Document | undefined;
  private bound: Array<[string, EventListener]> = [];

  constructor(target?: Document) {
    this.target = target ?? (typeof document !== 'undefined' ? document : undefined);
    this.attach();
  }

  private mark(): void {
    if (this.firstInteraction === null) this.firstInteraction = Date.now() - this.start;
  }

  private attach(): void {
    const t = this.target;
    if (!t) return;
    const on = (type: string, fn: EventListener) => {
      safe(() => t.addEventListener(type, fn, { passive: true } as AddEventListenerOptions), undefined);
      this.bound.push([type, fn]);
    };
    on('pointermove', (e) => this.onMove(e as PointerEvent));
    on('mousemove', (e) => this.onMove(e as MouseEvent));
    on('keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    on('keyup', (e) => this.onKeyUp(e as KeyboardEvent));
    on('paste', () => {
      this.mark();
      this.pastes += 1;
    });
    on('focusin', () => {
      this.mark();
      this.focusChanges += 1;
    });
    on('scroll', () => {
      this.mark();
      this.scrolls += 1;
    });
  }

  private onMove(e: { clientX?: number; clientY?: number }): void {
    this.mark();
    const x = e.clientX ?? 0;
    const y = e.clientY ?? 0;
    const now = Date.now();
    if (this.lastX !== null && this.lastY !== null) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const d = Math.hypot(dx, dy);
      this.distance += d;
      this.netDx += dx;
      this.netDy += dy;
      const dt = now - this.lastMoveT;
      if (dt > 0) {
        const speed = d / dt;
        this.speeds.push(speed);
        if (speed > this.maxSpeed) this.maxSpeed = speed;
      }
    }
    this.moves += 1;
    this.lastX = x;
    this.lastY = y;
    this.lastMoveT = now;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.mark();
    this.keyCount += 1;
    if (e.key === 'Backspace') this.backspaces += 1;
    // Keyed by physical code only — never the character. Content is never read.
    this.downAt.set(e.code || e.key || String(this.keyCount), Date.now());
    if (this.lastUpAt !== null) this.flight.push(Date.now() - this.lastUpAt);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const k = e.code || e.key || '';
    const down = this.downAt.get(k);
    const now = Date.now();
    if (down !== undefined) {
      this.dwell.push(now - down);
      this.downAt.delete(k);
    }
    this.lastUpAt = now;
  }

  /** A snapshot of aggregates so far. Safe to call repeatedly. */
  snapshot(): BehaviorSignals {
    const netDist = Math.hypot(this.netDx, this.netDy);
    return {
      mouseMoves: this.moves,
      mouseDistance: Math.round(this.distance),
      mouseAvgSpeed: mean(this.speeds),
      mouseMaxSpeed: Math.round(this.maxSpeed * 1000) / 1000,
      mouseSpeedVariance: variance(this.speeds),
      mouseStraightLineRatio: this.distance > 0 ? Math.min(1, netDist / this.distance) : null,
      keyCount: this.keyCount,
      keyAvgDwellMs: mean(this.dwell),
      keyAvgFlightMs: mean(this.flight),
      keyDwellVariance: variance(this.dwell),
      keyFlightVariance: variance(this.flight),
      pasteCount: this.pastes,
      backspaceCount: this.backspaces,
      timeToFirstInteractionMs: this.firstInteraction,
      timeToSubmitMs: Date.now() - this.start,
      focusChanges: this.focusChanges,
      scrollCount: this.scrolls,
      hadPointerMove: this.moves > 0,
      hadKeydown: this.keyCount > 0,
      interactionCount: this.moves + this.keyCount + this.scrolls + this.focusChanges,
    };
  }

  /** Detach all listeners. */
  stop(): void {
    const t = this.target;
    if (!t) return;
    for (const [type, fn] of this.bound) safe(() => t.removeEventListener(type, fn), undefined);
    this.bound = [];
  }
}

// ---- sending ---------------------------------------------------------------

export interface TelemetryOptions {
  /** FAPI base, e.g. 'https://accounts.acme.com' or '' for same-origin. */
  api: string;
  publishableKey: string;
  attemptId?: string;
  kind?: 'sign_in' | 'sign_up' | 'telemetry';
  recorder?: BehaviorRecorder;
  fetchImpl?: typeof fetch;
}

/**
 * Collect a device snapshot (+ behaviour from `recorder`, if given) and POST it.
 * Resolves `true` when the beacon was accepted, `false` otherwise — never
 * throws. Uses `navigator.sendBeacon` when possible so it survives navigation.
 */
export async function sendTelemetry(opts: TelemetryOptions): Promise<boolean> {
  return safe(async () => {
    const device = collectDeviceSignals();
    const payload = {
      attempt_id: opts.attemptId,
      kind: opts.kind ?? 'telemetry',
      device_id: deviceId(),
      device_fingerprint: deviceFingerprint(device),
      device,
      behavior: opts.recorder?.snapshot(),
    };
    const url = `${opts.api}/v1/client/telemetry?publishable_key=${encodeURIComponent(opts.publishableKey)}`;
    const body = JSON.stringify(payload);

    // Prefer sendBeacon in production: it is fire-and-forget and survives the
    // page unloading on submit. It cannot set the publishable-key HEADER, hence
    // the query param above. A caller that INJECTS a fetchImpl (tests, custom
    // transports) means "use exactly this" — so sendBeacon is skipped then.
    const n = nav();
    if (!opts.fetchImpl && n && typeof n.sendBeacon === 'function' && typeof Blob !== 'undefined') {
      const ok = n.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      if (ok) return true;
    }
    const doFetch = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!doFetch) return false;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-publishable-key': opts.publishableKey },
      body,
      keepalive: true,
      credentials: 'include',
    });
    return res.ok;
  }, Promise.resolve(false));
}
