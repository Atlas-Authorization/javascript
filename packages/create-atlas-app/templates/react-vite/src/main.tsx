import { AtlasProvider } from '@atlasauth/react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AtlasProvider
      publishableKey={import.meta.env.VITE_ATLAS_PUBLISHABLE_KEY ?? ''}
      frontendApi={import.meta.env.VITE_ATLAS_FRONTEND_API ?? 'https://atlasauth.net'}
    >
      <App />
    </AtlasProvider>
  </React.StrictMode>,
);
