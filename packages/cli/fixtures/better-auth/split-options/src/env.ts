import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    BETTER_AUTH_SECRET: z.string(),
    DISCORD_CLIENT_ID: z.string(),
    DISCORD_CLIENT_SECRET: z.string(),
    TURNSTILE_SECRET_KEY: z.string(),
  },
  runtimeEnv: process.env,
});
