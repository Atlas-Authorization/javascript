import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Resend from 'next-auth/providers/resend';
import Passkey from 'next-auth/providers/passkey';
import { prisma } from './db';
import { authConfig } from './auth.config';

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [...authConfig.providers, Resend({ from: 'login@shop.example' }), Passkey],
  session: { strategy: 'database', maxAge: 14 * 24 * 60 * 60 },
  experimental: { enableWebAuthn: true },
  callbacks: {
    session({ session, user }) {
      return { ...session, user: { ...session.user, id: user.id } };
    },
  },
});
