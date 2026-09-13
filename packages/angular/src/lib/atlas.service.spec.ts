import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { AtlasService } from './atlas.service';
import { provideAtlas } from './provide-atlas';

/**
 * A starter spec. Runs under the Angular CLI test runner (Karma/Jasmine or your
 * configured runner) — `ng test` / `pnpm --filter @atlasauth/angular test` once a
 * runner is wired up. It exercises the boot → signed-out path with a stubbed
 * fetch, and the imperative token path, without touching the network.
 */
describe('AtlasService', () => {
  function configure(fetchImpl: typeof fetch) {
    TestBed.configureTestingModule({
      providers: [provideAtlas({ publishableKey: 'pk_test_x', fetchImpl })],
    });
    return TestBed.inject(AtlasService);
  }

  it('boots to signed_out when /v1/client has no session', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ session: null, user: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const atlas = configure(fetchImpl);

    const status = await firstValueFrom(
      atlas.status$.pipe(
        filter((s) => s !== 'loading'),
        take(1),
      ),
    );

    expect(status).toBe('signed_out');
    expect(atlas.isSignedIn()).toBe(false);
    expect(await atlas.getToken()).toBeNull();
  });

  it('exposes the publishable key configuration through frontendApi default', () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const atlas = configure(fetchImpl);
    expect(atlas.frontendApi).toBe('');
  });
});
