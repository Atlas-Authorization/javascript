import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit 3 reads its configuration here, not from svelte.config.js.
export default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });
