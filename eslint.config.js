// ESLint 9 flat config. Type-aware rules are deliberately not enabled: linting
// must stay fast enough to run next to `npm run typecheck`, which already does
// the type checking.
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    {
        ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**', '**/*.js']
    },
    {
        files: ['src/**/*.ts', 'server/**/*.ts', 'cli/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'script',
            parserOptions: { ecmaFeatures: { jsx: false } }
        },
        plugins: { '@typescript-eslint': tsPlugin },
        rules: {
            // The codebase uses one-line guards (`if (!x) return;`) throughout;
            // braces are only required once the body moves to its own line.
            curly: ['error', 'multi-line'],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-throw-literal': 'error',
            'prefer-const': 'error',
            'no-var': 'error',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'off'
        }
    }
];
