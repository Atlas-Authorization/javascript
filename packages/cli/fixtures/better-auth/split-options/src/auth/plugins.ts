import { admin as adminPlugin, captcha, emailOTP, magicLink, organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from 'better-auth/plugins';
import { env } from '@/env';
import { ac, admin, billingManager, member } from './permissions';

const DAY = 60 * 60 * 24;

export const plugins = [
  organization({
    ac,
    roles: { member, admin, billingManager },
    creatorRole: 'owner',
    organizationLimit: 5,
    membershipLimit: 50,
    invitationExpiresIn: 7 * DAY,
    teams: { enabled: true, maximumTeams: 10, maximumMembersPerTeam: 25 },
    async sendInvitationEmail(data) {
      console.log(data);
    },
  }),
  twoFactor({
    issuer: 'Split',
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { amount: 8 },
    trustDeviceMaxAge: 14 * DAY,
  }),
  passkey({ rpID: 'split.example', rpName: 'Split', authenticatorSelection: { userVerification: 'required' } }),
  magicLink({ expiresIn: 600, sendMagicLink: async () => {} }),
  emailOTP({ otpLength: 8, expiresIn: 300, allowedAttempts: 5, sendVerificationOTP: async () => {} }),
  adminPlugin({ defaultRole: 'user', adminRoles: ['admin', 'support'], impersonationSessionDuration: 60 * 60 }),
  apiKey({ defaultPrefix: 'split_', keyExpiration: { defaultExpiresIn: 30 * DAY * 1000, maxExpiresIn: 90 } }),
  captcha({ provider: 'cloudflare-turnstile', secretKey: env.TURNSTILE_SECRET_KEY }),
];
