import { Button, Text, View } from 'react-native';
import { SignedIn, SignedOut, useAuth, useUser } from '@atlasauth/expo';
import { SignInForm } from '../components/SignInForm';

export default function Home() {
  const { user } = useUser();
  const { isLoaded, signOut, getToken } = useAuth();

  if (!isLoaded) return <Text>Loading…</Text>;

  // The token is what your own API verifies (with @atlasauth/backend on the server).
  const callApi = async () => {
    const token = await getToken();
    await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? ''}/me`, { headers: { Authorization: `Bearer ${token}` } });
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>{{PROJECT_NAME}}</Text>
      <SignedOut>
        <SignInForm />
      </SignedOut>
      <SignedIn>
        <Text>Signed in as {user?.first_name ?? user?.id}.</Text>
        <Button title="Call my API" onPress={() => void callApi()} />
        <Button title="Sign out" onPress={() => void signOut()} />
      </SignedIn>
    </View>
  );
}
