import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['baselines', 'dist', 'node_modules', 'report'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
      parser: tseslint.parser,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
