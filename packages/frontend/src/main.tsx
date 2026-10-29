import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './theme-hedgewitch.css';
import './theme/skins.generated.css';
import './theme/skins.css';
import { App } from './App';
import { useThemeStore } from './store/theme';
import { useAppearanceStore } from './store/appearance';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Apply any cached theme overrides synchronously, before first paint — avoids
// a flash of the default palette while the authenticated GET /api/theme
// (fired from AppShell, after login) is still in flight.
useThemeStore.getState().loadCache();
// The room, material and readability mode come from this browser's saved appearance document
// (index.html already set the attributes from it before first paint; this makes the store agree).
useAppearanceStore.getState().loadCache();

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
