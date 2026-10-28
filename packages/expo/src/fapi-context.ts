import { createContext } from 'react';
import type { FapiClient } from '@atlasauth/js';

/** The bearer-authenticated client `<AtlasProvider>` provides (null outside it). */
export const ExpoFapiContext = createContext<FapiClient | null>(null);
