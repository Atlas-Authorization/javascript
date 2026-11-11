// Step 2: the verification file Atlas fetches to prove you own the host. Reads ATLAS_VERIFY_TOKEN.
import { createVerifyHandler } from '@atlasauth/nextjs';

export const { GET } = createVerifyHandler();
