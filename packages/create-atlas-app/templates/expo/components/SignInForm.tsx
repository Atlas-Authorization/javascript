import { useMemo, useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { createSignInFlow } from '@atlasauth/js';
import { useExpoFapiClient } from '@atlasauth/expo';
import { useAtlas } from '@atlasauth/react';

/**
 * Email and password sign-in on the SDK's headless flow. The flow persists the session in the
 * token cache; reload() then lets the provider pick it up. A second factor or a required action
 * shows as another step: handle it with the flow's other methods (see the Atlas docs).
 */
export function SignInForm() {
  const client = useExpoFapiClient();
  const { reload } = useAtlas();
  const flow = useMemo(() => createSignInFlow({ client }), [client]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await flow.submitIdentifier(email.trim());
      const next = await flow.submitPassword(password);
      if (next.step.type === 'complete') await reload();
      else if (next.errors.length > 0) setMessage(next.errors[0]!.message ?? 'Sign-in failed.');
      else setMessage(`More is needed to finish signing in (${next.step.type}).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <TextInput value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" />
      <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      <Button title={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !email || !password} onPress={() => void submit()} />
      {message ? <Text>{message}</Text> : null}
    </View>
  );
}
