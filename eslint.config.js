const js = require("@eslint/js");

module.exports = [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "commonjs",
			globals: {
				require: "readonly",
				module: "readonly",
				exports: "readonly",
				process: "readonly",
				console: "readonly",
				Buffer: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
			},
		},
			rules: {
				"no-global-return": "off",
				"no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
				"no-constant-condition": ["error", { checkLoops: false }],
				"prefer-const": "warn",
				"no-var": "error",
			},
			ignores: ["node_modules/**", "export/**", "logs/**"],
	},
];
