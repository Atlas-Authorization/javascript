// Step 1: serve the Atlas Frontend API under /atlas. Reads ATLAS_UPSTREAM and ATLAS_PROXY_SECRET.
import { createMountHandler } from '@atlasauth/nextjs';

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = createMountHandler({
  basePath: process.env.ATLAS_BASE_PATH ?? '/atlas',
});
