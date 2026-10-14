import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Directive, ElementRef, OnInit, PLATFORM_ID, Renderer2, inject } from '@angular/core';
import { applyAppearanceToDom } from '@atlasauth/design/runtime';
import { AtlasService } from '../atlas.service';

/**
 * `atlasRoot` — apply the resolved appearance design tokens as `--atlas-*` CSS
 * custom properties (and the `atlas-root` class) onto its host element, so the
 * Atlas components rendered inside inherit them.
 *
 * React does this with the wrapping `<div className="atlas-root" style={…}>`
 * inside `<AtlasProvider>`. Angular has no single wrapping element, so a
 * consumer opts in by putting `atlasRoot` on whatever element encloses the
 * Atlas UI (commonly the app root):
 *
 * ```html
 * <div atlasRoot>
 *   <router-outlet></router-outlet>
 * </div>
 * ```
 *
 * With a design (a code-level `appearance.preset` / `appearance.design`, or
 * the dashboard design, fetched in the browser) the host also gets the stable
 * `data-atlas-*` attributes and the design stylesheet is added to `<head>` once.
 */
@Directive({
  selector: '[atlasRoot]',
  standalone: true,
})
export class AtlasRootDirective implements OnInit {
  private readonly atlas = inject(AtlasService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);

  ngOnInit(): void {
    const host = this.el.nativeElement;
    this.renderer.addClass(host, 'atlas-root');
    // Custom properties via `style.setProperty` (written verbatim, never camelCased).
    let applied = applyAppearanceToDom(this.document, host, this.atlas.appearanceRender());
    if (!isPlatformBrowser(this.platformId)) return;
    void this.atlas.loadInstanceDesign().then((design) => {
      if (!design) return;
      applied = applyAppearanceToDom(this.document, host, this.atlas.appearanceRender(design), applied);
    });
  }
}
