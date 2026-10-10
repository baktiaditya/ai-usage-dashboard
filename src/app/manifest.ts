import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AI Usage Dashboard',
    short_name: 'AI Usage',
    description: 'Local dashboard for Codex and Claude Code quota and DeepSeek/OpenRouter balance.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f7f8',
    theme_color: '#4338ca',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
