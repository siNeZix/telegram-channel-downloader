const { parseArgs, resolveChannelId, resolveExportDir, formatHelp } = require("../utils/cli_utils");

/**
 * Central command catalog for the unified CLI.
 *
 * Every entry point (index.js + the standalone utility scripts) routes through
 * the same parser so flag syntax, channel-id handling and export-dir resolution
 * stay consistent across the whole tool.
 *
 * Validation depth is unified into a single model everywhere:
 *   --check  -> fast validation (ffprobe metadata)
 *   --deep   -> full decode validation
 *   --strict -> deep + strict profile
 */

// Shared validation flags reused by `download` and `valid`.
const VALIDATION_BOOLEANS = [
	{ name: "check", flags: ["--check"], help: "Fast validation of existing files (cheap cascade, no decode)" },
	{ name: "deep", flags: ["--deep", "-D"], help: "Deep validation (full decode)" },
	{
		name: "strict",
		flags: ["--strict"],
		help: "Strict profile (implies --deep)",
		apply: (result) => {
			result.deep = true;
		},
	},
	{
		name: "verifyHash",
		flags: ["--verify-hash"],
		help: "Verify integrity via Telegram SHA256 file hashes (extra RPC per file)",
	},
];

const CHANNEL_VALUE = {
	name: "channel",
	flags: ["--channel"],
	help: "Channel id (numeric)",
	transform: resolveChannelId,
};

const COMMANDS = {
	download: {
		summary: "Download all messages and media from a channel",
		spec: {
			values: [CHANNEL_VALUE],
			booleans: [
				...VALIDATION_BOOLEANS,
				{ name: "auto", flags: ["--auto", "-y"], help: "Non-interactive; accept all defaults" },
			],
			defaults: { channel: null, check: false, deep: false, strict: false, verifyHash: false, auto: false },
		},
	},
	"rebuild-db": {
		summary: "Rebuild the SQLite database from the Telegram API (no media)",
		spec: {
			values: [CHANNEL_VALUE],
			defaults: { channel: null },
			positionalName: "channel", // legacy: `rebuild-db <id>`
		},
	},
	listen: {
		summary: "Listen for new messages in real time",
		spec: {
			values: [CHANNEL_VALUE],
			defaults: { channel: null },
		},
	},
	ids: {
		summary: "Download specific message ids from a channel",
		spec: {
			values: [
				CHANNEL_VALUE,
				{
					name: "messages",
					flags: ["--messages", "--ids"],
					help: "Comma-separated message ids",
					transform: (raw) =>
						(raw || "")
							.split(",")
							.map((s) => Number(s.trim()))
							.filter((n) => Number.isFinite(n) && n !== 0),
				},
			],
			defaults: { channel: null, messages: [] },
		},
	},
	valid: {
		summary: "Validate downloaded media files",
		spec: {
			booleans: [
				...VALIDATION_BOOLEANS,
				{ name: "dryRun", flags: ["--dry-run", "-d"], help: "Report only; do not quarantine" },
				{ name: "verbose", flags: ["--verbose", "-v"], help: "Detailed per-file output" },
				{ name: "cache", flags: ["--cache", "-c"], help: "Verify files against the database" },
				{
					name: "ignoreSnapshots",
					flags: ["--ignore-snapshots", "-S"],
					help: "Re-check files even if covered by a snapshot",
				},
				{ name: "image", flags: ["--images", "-i"], help: "Limit to image files" },
				{ name: "video", flags: ["--videos", "-V"], help: "Limit to video files" },
				{ name: "audio", flags: ["--audio", "-A"], help: "Limit to audio files" },
			],
			defaults: {
				dryRun: false,
				verbose: false,
				deep: false,
				strict: false,
				verifyHash: false,
				cache: false,
				ignoreSnapshots: false,
				image: false,
				video: false,
				audio: false,
			},
			positionalName: "path", // optional export-dir path
		},
	},
	snapshot: {
		summary: "Create validation snapshots for all channels",
		spec: { positionalName: "path" },
	},
	export: {
		summary: "Rebuild JSON Lines exports from the SQLite databases",
		spec: { positionalName: "path" },
	},
	restore: {
		summary: "Restore quarantined files (optionally for specific channels)",
		spec: { positionalName: "channels" }, // 0+ channel ids
	},
};

/**
 * Parse argv for a known command name. Runtime path options
 * (--root/--export-dir/...) must already have been stripped by
 * parseRuntimeOptions before calling this.
 *
 * @param {string} command
 * @param {string[]} args - argv tail (without runtime options or command name)
 * @returns {object} parsed options (+ positionals, unknown)
 */
const parseCommand = (command, args) => {
	const entry = COMMANDS[command];
	if (!entry) {
		return null;
	}
	return parseArgs(args, entry.spec || {});
};

/**
 * Map a parsed `valid` result into the options object runValidation expects.
 * @param {object} parsed
 * @returns {object}
 */
const toValidationOptions = (parsed) => {
	const type = parsed.image ? "image" : parsed.video ? "video" : parsed.audio ? "audio" : "all";
	const options = {
		dryRun: !!parsed.dryRun,
		verbose: !!parsed.verbose,
		type,
		deep: !!parsed.deep || !!parsed.strict,
		strict: !!parsed.strict,
		verifyHash: !!parsed.verifyHash,
		ignoreSnapshots: !!parsed.ignoreSnapshots,
		cache: !!parsed.cache,
	};
	const positional = (parsed.positionals || [])[0];
	if (positional) {
		options.exportPath = resolveExportDir(positional);
	}
	return options;
};

/**
 * Resolve the unified validation flags into a single validation profile. This
 * is the one source of truth used everywhere (download + valid), so --strict no
 * longer silently collapses into --deep.
 * @param {object} parsed
 * @returns {"none"|"fast"|"sampled"|"full"|"strict"}
 */
const toValidationProfile = (parsed) => {
	if (parsed.strict) return "strict";
	if (parsed.deep) return "full";
	if (parsed.check) return "fast";
	return "none";
};

/**
 * Translate the unified validation flags into the download check mode/plan.
 * Returns both the legacy coarse mode and the resolved profile so callers can
 * gate ffmpeg init (enabled) and pick the exact validation strategy (profile).
 * @param {object} parsed
 * @returns {{ enabled: boolean, profile: string, verifyHash: boolean }}
 */
const toCheckMode = (parsed) => {
	const profile = toValidationProfile(parsed);
	return {
		enabled: profile !== "none",
		profile,
		verifyHash: !!parsed.verifyHash,
	};
};

const listCommands = () => Object.keys(COMMANDS);

/**
 * Build the top-level `--help` text.
 * @returns {string}
 */
const formatTopLevelHelp = () => {
	const lines = ["Usage: node index.js [command] [options]", "", "Commands:"];
	const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
	for (const [name, entry] of Object.entries(COMMANDS)) {
		lines.push(`  ${name.padEnd(width)}  ${entry.summary}`);
	}
	lines.push(
		"",
		"Run with no command for the interactive menu.",
		"",
		"Global options:",
		"  --root <path>         Override project root",
		"  --export-dir <path>   Override export directory",
		"  --config-file <path>  Override config.json location",
		"  --logs-dir <path>     Override logs directory",
		"  --help, -h            Show help",
		"  --version             Show version",
		"",
		"Run `node index.js <command> --help` for command-specific options.",
	);
	return lines.join("\n");
};

/**
 * Build per-command `--help` text.
 * @param {string} command
 * @returns {string}
 */
const formatCommandHelp = (command) => {
	const entry = COMMANDS[command];
	if (!entry) {
		return formatTopLevelHelp();
	}
	const positionalSuffix = entry.spec?.positionalName ? ` [${entry.spec.positionalName}]` : "";
	return formatHelp({
		usage: `node index.js ${command}${positionalSuffix} [options]`,
		description: entry.summary,
		spec: entry.spec || {},
	});
};

module.exports = {
	COMMANDS,
	parseCommand,
	toValidationOptions,
	toCheckMode,
	toValidationProfile,
	listCommands,
	formatTopLevelHelp,
	formatCommandHelp,
};
