import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The wrap renders through React + Testing Library, which needs a DOM.
    environment: 'jsdom',
  },
});
