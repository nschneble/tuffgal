import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'report', 'baselines'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ['src/**/*.ts', 'bin/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
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
