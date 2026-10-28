import type { BetterAuthOptions } from 'better-auth';
import { env } from '@/env';

const base = {
  secret: env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
} satisfies Partial<BetterAuthOptions>;

export const authOptions = {
  ...base,
  emailAndPassword: { enabled: true },
  socialProviders: {
    discord: { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, disableSignUp: true },
  },
  session: { expiresIn: 60 * 60 * 24 * 7, disableSessionRefresh: true, freshAge: 60 * 10 },
  account: { accountLinking: { enabled: true, trustedProviders: ['discord', 'email-password'] } },
} satisfies BetterAuthOptions;
