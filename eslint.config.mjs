import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  ...nextVitals,
  { ignores: ['.next/**', '.next-desktop/**', 'dist-desktop/**', 'build-desktop/**', 'workspace/**', 'electron/**', 'docs/**', 'coverage/**', 'test-results/**', 'next-env.d.ts'] },
  {
    rules: {
      // Avatars and the floorplan are small local images drawn at fixed sizes
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
