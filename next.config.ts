import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // A container runs the traced server bundle, not this repository: the image
  // then carries no build toolchain and no devDependencies.
  output: 'standalone',
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;
