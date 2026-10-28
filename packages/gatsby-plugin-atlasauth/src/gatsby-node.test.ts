import { describe, expect, it, vi } from 'vitest';
import { onCreateWebpackConfig } from './gatsby-node';

function harness() {
  const setWebpackConfig = vi.fn();
  const define = vi.fn((defs: Record<string, string>) => ({ DefinePlugin: defs }));
  return {
    args: { actions: { setWebpackConfig }, plugins: { define } },
    setWebpackConfig,
    define,
  };
}

describe('onCreateWebpackConfig', () => {
  it('forwards resolved options into the browser bundle as GATSBY_* defines', () => {
    const h = harness();
    onCreateWebpackConfig(h.args, {
      publishableKey: 'pk_live_x',
      frontendApi: 'https://auth.acme.com',
    });

    expect(h.define).toHaveBeenCalledWith({
      'process.env.GATSBY_ATLAS_PUBLISHABLE_KEY': JSON.stringify('pk_live_x'),
      'process.env.GATSBY_ATLAS_FRONTEND_API': JSON.stringify('https://auth.acme.com'),
    });
    expect(h.setWebpackConfig).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no key or frontend API to forward', () => {
    const h = harness();
    onCreateWebpackConfig(h.args, {});
    expect(h.define).not.toHaveBeenCalled();
    expect(h.setWebpackConfig).not.toHaveBeenCalled();
  });
});
