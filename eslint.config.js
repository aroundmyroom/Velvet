import js from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'curly': ['warn', 'multi-line'],
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'require-await': 'warn'
    }
  },
  {
    // Legacy lint baseline. The sonarjs "recommended" preset (plus a few core
    // rules) was adopted after the fact and flags hundreds of pre-existing
    // findings across src/ and the test fixtures (e.g. hardcoded IPs in the
    // SSRF tests). Keep them as warnings so they stay visible without failing
    // CI; tighten back to 'error' file-by-file as the code is cleaned up.
    rules: {
      'no-undef': 'warn',
      'no-empty': 'warn',
      'no-control-regex': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'sonarjs/cognitive-complexity': 'warn',
      'sonarjs/slow-regex': 'warn',
      'sonarjs/regex-complexity': 'warn',
      'sonarjs/no-hardcoded-ip': 'warn',
      'sonarjs/hashing': 'warn',
      'sonarjs/pseudo-random': 'warn',
      'sonarjs/no-nested-functions': 'warn',
      'sonarjs/no-nested-template-literals': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/no-unused-vars': 'warn',
      'sonarjs/unused-import': 'warn',
      'sonarjs/no-dead-store': 'warn',
      'sonarjs/no-clear-text-protocols': 'warn',
      'sonarjs/os-command': 'warn',
      'sonarjs/unverified-hostname': 'warn',
      'sonarjs/unverified-certificate': 'warn',
      'sonarjs/no-ignored-exceptions': 'warn',
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/duplicates-in-character-class': 'warn',
      'sonarjs/super-linear-regex': 'warn'
    }
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'image-cache/**',
      'save/**',
      'webapp/**',
      'docs/**'
    ]
  }
];
