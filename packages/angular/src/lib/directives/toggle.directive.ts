import {
  Directive,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewContainerRef,
  inject,
} from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { AtlasService } from '../atlas.service';

/**
 * Shared machinery for the boolean structural directives (`*atlasSignedIn`,
 * `*atlasSignedOut`, `*atlasLoading`, `*atlasLoaded`). A subclass names the
 * stream to gate on; this base mounts the embedded view exactly when that stream
 * is true and tears it down otherwise, mirroring how the React `<SignedIn>` /
 * `<SignedOut>` components render `children` or `null`.
 */
@Directive()
export abstract class AtlasToggleDirective implements OnInit, OnDestroy {
  protected readonly atlas = inject(AtlasService);
  private readonly templateRef = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private sub?: Subscription;
  private shown = false;

  /** The stream whose truthiness controls whether the template renders. */
  protected abstract source(): Observable<boolean>;

  ngOnInit(): void {
    this.sub = this.source()
      .pipe(distinctUntilChanged())
      .subscribe((show) => this.render(show));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private render(show: boolean): void {
    if (show && !this.shown) {
      this.viewContainer.createEmbeddedView(this.templateRef);
      this.shown = true;
    } else if (!show && this.shown) {
      this.viewContainer.clear();
      this.shown = false;
    }
  }
}
