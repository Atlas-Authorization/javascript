import { Lucia, TimeSpan } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { GitHub, Google } from 'arctic';
import { db, sessionTable, userTable } from './db';

const adapter = new DrizzlePostgreSQLAdapter(db, sessionTable, userTable);

export const lucia = new Lucia(adapter, {
  sessionExpiresIn: new TimeSpan(2, 'w'),
  sessionCookie: {
    name: 'blog_session',
    attributes: { secure: process.env.NODE_ENV === 'production' },
  },
  getUserAttributes: (attributes) => ({ username: attributes.username }),
});

export const github = new GitHub(process.env.GITHUB_CLIENT_ID!, process.env.GITHUB_CLIENT_SECRET!);
export const google = new Google(process.env.GOOGLE_CLIENT_ID!, process.env.GOOGLE_CLIENT_SECRET!, 'https://blog.example.com/login/google/callback');
