/// <reference types="vite/client" />

// Injected at build time by vite.config.ts define block.
// At runtime this is the git short-hash (or 'dev' when running locally
// without BUILD_ID set). Used by the version-check hook in App.tsx to
// detect when the backend has been redeployed while the tab was backgrounded.
declare const __BUILD_ID__: string;
