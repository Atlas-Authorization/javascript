import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { atlasAstro } from '@atlasauth/astro';

// Server output: the Atlas middleware verifies the session on every request.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [atlasAstro()],
});
