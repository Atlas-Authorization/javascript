import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from '@angular/core';
import type { CaptchaController } from '@atlasauth/js';

/**
 * `[atlasCaptchaSlot]="controller"` — the element a flow's captcha widget draws
 * into (see `createCaptchaController` in `@atlasauth/js`). Attaches the
 * controller to the host element while it is rendered and detaches it (removing
 * the widget) when it goes away.
 */
@Directive({
  selector: '[atlasCaptchaSlot]',
  standalone: true,
})
export class AtlasCaptchaSlotDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private current: CaptchaController | null = null;
  private initialized = false;

  @Input('atlasCaptchaSlot') set controller(next: CaptchaController | null) {
    if (next === this.current) return;
    if (this.initialized) this.current?.attach(null);
    this.current = next;
    if (this.initialized) this.current?.attach(this.host.nativeElement);
  }

  ngOnInit(): void {
    this.initialized = true;
    this.current?.attach(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.current?.attach(null);
  }
}
