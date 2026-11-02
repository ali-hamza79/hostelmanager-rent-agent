import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      strategies: 'generateSW',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        // This is the crucial line that fixes the popup loop!
        navigateFallbackDenylist: [/^\/__\/auth\//, /^\/__\/firebase\//],
      },
      manifest: {
        name: 'Hostel Manager',
        short_name: 'Hostel Manager',
        start_url: '/',
        display: 'standalone',
        background_color: '#0b172b',
        theme_color: '#0b172b',
        description: 'Offline hostel management and rent tracking PWA',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});