import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/routeTree.gen.ts', 'bin/**', 'build/**', 'build-integrado/**', 'lib/**',
    'src/**', 'config/**', 'data/**', 'images/**', 'import/**', 'infra/**', 'backups/**',
    'test-results/**', 'e2e-artifacts/**', 'playwright-report/**', 'apps/api/uploads/**', 'apps/api/backups/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
