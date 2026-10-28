import NextAuth, { type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import AzureADProvider from 'next-auth/providers/azure-ad';

export const authOptions: NextAuthOptions = {
  providers: [
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: 'hard-coded-secret-value',
      tenantId: process.env.AZURE_AD_TENANT_ID,
    }),
    CredentialsProvider({
      name: 'Email',
      credentials: { email: { label: 'Email' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials) {
        return null;
      },
    }),
  ],
  session: { maxAge: 7 * 24 * 60 * 60 },
  cookies: { sessionToken: { name: 'legacy.session', options: { httpOnly: true } } },
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
