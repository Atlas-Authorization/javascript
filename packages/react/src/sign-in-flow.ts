'use client';

import { useEffect, useMemo, useState } from 'react';
import { createSignInFlow, createSignUpFlow, type FlowSnapshot, type SignInFlow, type SignUpFlow } from '@atlasauth/js';
import { useFapiClient } from './components-shared';

/** Subscribe a React component to a headless flow. */
function useFlow<F extends { getSnapshot(): FlowSnapshot; subscribe(l: (s: FlowSnapshot) => void): () => void }>(
  make: () => F,
): F & { snapshot: FlowSnapshot } {
  const flow = useMemo(make, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [snapshot, setSnapshot] = useState<FlowSnapshot>(flow.getSnapshot());
  useEffect(() => flow.subscribe(setSnapshot), [flow]);
  return { ...flow, snapshot };
}

/**
 * Headless sign-in with no UI: `const { snapshot, submitIdentifier, submitPassword, … } = useSignInFlow()`.
 * Render `snapshot.step`, call the method for it. See "Build your own sign-in pages".
 */
export function useSignInFlow(): SignInFlow & { snapshot: FlowSnapshot } {
  const client = useFapiClient();
  return useFlow(() => createSignInFlow({ client }));
}

/** Headless sign-up with no UI; the same shape as {@link useSignInFlow}. */
export function useSignUpFlow(): SignUpFlow & { snapshot: FlowSnapshot } {
  const client = useFapiClient();
  return useFlow(() => createSignUpFlow({ client }));
}
