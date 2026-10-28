import { betterAuth } from 'better-auth';
import { authOptions } from '@/auth/options';
import { plugins } from '@/auth/plugins';

export const auth = betterAuth({
  ...authOptions,
  plugins,
});
