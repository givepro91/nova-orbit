import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'confirm', message: 'Use ConfirmDialog component (dashboard/src/components/ConfirmDialog.tsx) instead.' },
        { name: 'alert', message: 'Use Toast component (dashboard/src/components/Toast.tsx) instead.' },
        { name: 'prompt', message: 'Use InputDialog component (dashboard/src/components/InputDialog.tsx) instead.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'confirm', message: 'Use ConfirmDialog component instead.' },
        { object: 'window', property: 'alert', message: 'Use Toast component instead.' },
        { object: 'window', property: 'prompt', message: 'Use InputDialog component instead.' },
      ],
    },
  },
])
