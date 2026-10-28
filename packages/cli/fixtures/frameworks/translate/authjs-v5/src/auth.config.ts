import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  providers: [
    GitHub,
    Google({
      clientId: process.env.GOOGLE_ID,
      clientSecret: process.env.GOOGLE_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  pages: { signIn: '/login' },
} satisfies NextAuthConfig;
