import { atlasClient } from '@atlasauth/nextjs/server';

// One Backend API client from ATLAS_SECRET_KEY (server only).
export const atlas = atlasClient();
