// Step 6: Atlas asks for your id for a new user BEFORE it creates them, so both sides share external_id.
import { createBeforeUserCreateHandler } from '@atlasauth/nextjs';

export const POST = createBeforeUserCreateHandler({
  secret: process.env.ATLAS_HOOK_SECRET,
  externalId: () => crypto.randomUUID(),
});
