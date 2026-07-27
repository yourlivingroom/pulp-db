import js from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';

// Local rule: no imports below the first non-import statement. The obvious
// off-the-shelf option (eslint-plugin-import-x) drags in a native resolver
// with per-platform binaries whose optional dependencies npm records
// differently depending on where `npm install` ran, which breaks `npm ci` on
// other platforms. Not worth it for fifteen lines.
const localPlugin = {
    rules: {
        'imports-first': {
            meta: {
                type: 'layout',
                docs: { description: 'Require imports before other code' },
                schema: [],
                messages: {
                    importAfterCode:
                        'Import must appear before any other statement.',
                },
            },
            create(context) {
                return {
                    Program(program) {
                        let sawStatement = false;

                        for (const statement of program.body) {
                            if (statement.type === 'ImportDeclaration') {
                                if (sawStatement) {
                                    context.report({
                                        node: statement,
                                        messageId: 'importAfterCode',
                                    });
                                }
                            } else {
                                sawStatement = true;
                            }
                        }
                    },
                };
            },
        },
    },
};

export default [
    { ignores: ['scratch/'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        plugins: {
            local: localPlugin,
            perfectionist,
        },
        rules: {
            eqeqeq: ['error', 'always'],

            'local/imports-first': 'error',

            // Whole-module imports first, then destructuring ones, each
            // block alphabetized by module name.
            'perfectionist/sort-imports': [
                'error',
                {
                    type: 'alphabetical',
                    order: 'asc',
                    ignoreCase: true,
                    newlinesBetween: 1,
                    groups: ['default-import', 'named-import', 'unknown'],
                },
            ],
        },
    },
];
