// Step 7: verified, de-duplicated webhooks. A repeated delivery id is answered 200 and not run again.
// memoryDedupeStore is per process: use sqlDedupeStore (or your own) when you run several instances.
import { createWebhookHandler, memoryDedupeStore } from '@atlasauth/nextjs';
import { seenEvents, users } from '@/lib/store';

export const POST = createWebhookHandler({
  secret: process.env.ATLAS_WEBHOOK_SECRET,
  store: memoryDedupeStore(),
  onEvent: async (event) => {
    seenEvents.push(event.type);
    // Keep your table honest when an account is removed in Atlas.
    if (event.type === 'user.deleted') {
      for (const [id, u] of users) if (u.atlasSub === event.data?.id) users.delete(id);
    }
  },
});
