import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Flat config. `eslint-config-next` v16 ships native flat configs, so the
 * legacy `FlatCompat` bridge is not used here — it cannot serialise the Next
 * plugin object and throws on a circular structure.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.playwright/**',
      'next-env.d.ts',
      'src/lib/db/migrations.generated.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Money must never travel through binary floating point.
          selector:
            "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message:
            'Use the decimal helpers in @/lib/money instead of parseFloat for monetary values.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'Use the decimal helpers in @/lib/money instead of parseFloat for monetary values.',
        },
      ],
    },
  },
];

export default config;
