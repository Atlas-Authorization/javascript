import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, adminAc } from 'better-auth/plugins/organization/access';

const statement = {
  ...defaultStatements,
  project: ['create', 'share', 'update', 'delete'],
  billing: ['manage'],
} as const;

export const ac = createAccessControl(statement);

export const member = ac.newRole({
  project: ['create'],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  project: ['create', 'update'],
});

export const billingManager = ac.newRole({
  billing: ['manage'],
  member: ['update'],
});
