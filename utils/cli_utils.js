const path = require("path");
const paths = require("./paths");

/**
 * Pull an option that takes a value out of an argv array (mutating it).
 * The next token is consumed as the value ONLY if it is not itself a flag
 * (does not start with "-"). Otherwise the option is treated as valueless.
 *
 * @param {string[]} args - argv array (mutated in place)
 * @param {string} optionName - e.g. "--root"
 * @returns {string|undefined}
 */
const takeOptionValue = (args, optionName) => {
	const optionIndex = args.indexOf(optionName);
	if (optionIndex === -1) {
		return undefined;
	}

	const optionValue = args[optionIndex + 1];
	const hasValue = optionValue !== undefined && !optionValue.startsWith("-");
	args.splice(optionIndex, hasValue ? 2 : 1);
	return hasValue ? optionValue : undefined;
};

/**
 * Extract the shared runtime path options (--root/--export-dir/--config-file/
 * --logs-dir) from argv and apply them to the global paths manager.
 * Mutates `args`, removing the consumed tokens so command parsers only see
 * their own flags.
 *
 * @param {string[]} args
 * @returns {{root?:string, exportDir?:string, configFile?:string, logsDir?:string}}
 */
const parseRuntimeOptions = (args) => {
	const result = {
		root: takeOptionValue(args, "--root"),
		exportDir: takeOptionValue(args, "--export-dir"),
		configFile: takeOptionValue(args, "--config-file"),
		logsDir: takeOptionValue(args, "--logs-dir"),
	};
	paths.configure(result);
	return result;
};

/**
 * Declarative argv parser.
 *
 * spec = {
 *   booleans: [{ name: "deep", flags: ["--deep", "-D"] }, ...],
 *   values:   [{ name: "channel", flags: ["--channel"] }, ...],
 *   defaults: { deep: false, channel: undefined },
 *   positionalName: "path", // collected non-flag tokens => result.positionals
 * }
 *
 * Unknown flags are collected in result.unknown so callers can warn/fail.
 *
 * @param {string[]} args - argv array (already stripped of runtime options)
 * @param {object} spec
 * @returns {object} parsed result + { positionals: string[], unknown: string[] }
 */
const parseArgs = (args, spec = {}) => {
	const booleans = spec.booleans || [];
	const values = spec.values || [];

	const result = { positionals: [], unknown: [], ...(spec.defaults || {}) };

	const booleanByFlag = new Map();
	for (const b of booleans) {
		for (const flag of b.flags) {
			booleanByFlag.set(flag, b);
		}
	}

	const valueByFlag = new Map();
	for (const v of values) {
		for (const flag of v.flags) {
			valueByFlag.set(flag, v);
		}
	}

	const remaining = [...args];
	while (remaining.length > 0) {
		const token = remaining.shift();

		if (booleanByFlag.has(token)) {
			const def = booleanByFlag.get(token);
			result[def.name] = true;
			if (typeof def.apply === "function") {
				def.apply(result);
			}
			continue;
		}

		if (valueByFlag.has(token)) {
			const def = valueByFlag.get(token);
			const next = remaining[0];
			const hasValue = next !== undefined && !next.startsWith("-");
			const raw = hasValue ? remaining.shift() : undefined;
			result[def.name] = typeof def.transform === "function" ? def.transform(raw) : raw;
			continue;
		}

		if (token.startsWith("-")) {
			result.unknown.push(token);
			continue;
		}

		result.positionals.push(token);
	}

	return result;
};

/**
 * Resolve a channel id from a raw CLI value into a finite non-zero number,
 * or null when absent/invalid.
 * @param {*} value
 * @returns {number|null}
 */
const resolveChannelId = (value) => {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
};

/**
 * Resolve an optional positional export-dir argument relative to paths.root.
 * Falls back to the configured paths.export when no positional was given.
 * @param {string|undefined} positional
 * @returns {string}
 */
const resolveExportDir = (positional) => {
	if (!positional) {
		return paths.export;
	}
	return path.isAbsolute(positional) ? positional : path.resolve(paths.root, positional);
};

/**
 * Render a help string from a command spec for `--help`.
 * @param {object} options
 * @param {string} options.usage
 * @param {string} [options.description]
 * @param {object} [options.spec] - the parseArgs spec (booleans/values)
 * @returns {string}
 */
const formatHelp = ({ usage, description, spec = {} }) => {
	const lines = [];
	if (usage) {
		lines.push(`Usage: ${usage}`);
	}
	if (description) {
		lines.push("", description);
	}

	const optionRows = [];
	for (const v of spec.values || []) {
		optionRows.push([`${v.flags.join(", ")} <${v.name}>`, v.help || ""]);
	}
	for (const b of spec.booleans || []) {
		optionRows.push([b.flags.join(", "), b.help || ""]);
	}

	if (optionRows.length > 0) {
		lines.push("", "Options:");
		const width = Math.max(...optionRows.map(([left]) => left.length));
		for (const [left, right] of optionRows) {
			lines.push(`  ${left.padEnd(width)}  ${right}`.trimEnd());
		}
	}

	return lines.join("\n");
};

module.exports = {
	takeOptionValue,
	parseRuntimeOptions,
	parseArgs,
	resolveChannelId,
	resolveExportDir,
	formatHelp,
};
