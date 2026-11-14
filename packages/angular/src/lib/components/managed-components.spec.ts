import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import * as api from '../../public-api';
import { controllerSignal } from './managed';
import { ObservableController } from '@atlasauth/js';
import { signal } from '@angular/core';

/** API keys, billing and device authorization: exported, part of ATLAS_UI, and driven by the shared controllers. */
describe('API keys, billing and device authorization components', () => {
  it('are exported and part of ATLAS_UI', () => {
    for (const c of [api.ApiKeysComponent, api.DeviceAuthorizationComponent, api.PricingTableComponent, api.InvoicesComponent, api.EmbeddedCheckoutComponent, api.CheckoutComponent]) {
      expect(c).toBeTypeOf('function');
      expect(api.ATLAS_UI).toContain(c);
    }
  });

  it('exports the usage helper', () => {
    expect(api.injectUsage).toBeTypeOf('function');
  });

  it('controllerSignal mirrors the snapshot and unsubscribes on destroy', () => {
    class C extends ObservableController<{ n: number }> {
      constructor() {
        super({ n: 0 });
      }
      bump() {
        this.patch({ n: this.getState().n + 1 });
      }
    }
    const c = new C();
    let destroy = () => {};
    const state = controllerSignal(c, { onDestroy: (fn: () => void) => ((destroy = fn), () => {}) } as never);
    c.bump();
    expect(state().n).toBe(1);
    destroy();
    c.bump();
    expect(state().n).toBe(1);
    void signal;
  });
});
