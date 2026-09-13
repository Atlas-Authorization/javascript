import {
  Directive,
  ElementRef,
  OnInit,
  Renderer2,
  RendererStyleFlags2,
  inject,
} from '@angular/core';
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
 */
@Directive({
  selector: '[atlasRoot]',
  standalone: true,
})
export class AtlasRootDirective implements OnInit {
  private readonly atlas = inject(AtlasService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);

  ngOnInit(): void {
    this.renderer.addClass(this.el.nativeElement, 'atlas-root');
    const vars = this.atlas.appearanceVariables();
    for (const [name, value] of Object.entries(vars)) {
      // DashCase so a `--atlas-*` custom property is written verbatim, not camelCased.
      this.renderer.setStyle(this.el.nativeElement, name, value, RendererStyleFlags2.DashCase);
    }
  }
}
