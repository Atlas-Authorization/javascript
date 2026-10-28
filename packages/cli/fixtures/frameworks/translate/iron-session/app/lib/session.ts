import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';

export const sessionOptions: SessionOptions = {
  password: process.env.SECRET_COOKIE_PASSWORD!,
  cookieName: 'dash-session',
  ttl: 60 * 60 * 24 * 7,
  cookieOptions: { secure: true },
};

export async function getSession() {
  return getIronSession<{ userId?: string }>(await cookies(), sessionOptions);
}
