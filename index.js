const paths = require("./utils/paths");
const path = require("path");
const { parseRuntimeOptions } = require("./utils/cli_utils");
const {
	parseCommand,
	toValidationOptions,
	toCheckMode,
	formatTopLevelHelp,
	formatCommandHelp,
	COMMANDS,
} = require("./cli/commands");

const PKG_VERSION = "__PKG_VERSION__";
const pkg = { version: PKG_VERSION !== "__PKG_VERSION__" ? PKG_VERSION : require("./package.json").version };

// argv tail; runtime path options are stripped first so command parsers only
// see their own flags (and paths.* is configured as a side effect).
const args = process.argv.slice(2);
parseRuntimeOptions(args);

const appPaths = {
	exportPath: paths.export,
};

// --- Top-level help / version (handled before any auth or heavy requires) ---
if (args.includes("--help") || args.includes("-h")) {
	const maybeCommand = args.find((a) => !a.startsWith("-"));
	console.log(maybeCommand && COMMANDS[maybeCommand] ? formatCommandHelp(maybeCommand) : formatTopLevelHelp());
	return;
}
if (args.includes("--version")) {
	console.log(pkg.version);
	return;
}

// First non-flag token is the command. Default to interactive menu.
const command = args.find((a) => !a.startsWith("-")) || "menu";

if (command !== "menu" && !COMMANDS[command]) {
	console.error(`Unknown command: ${command}`);
	console.error(formatTopLevelHelp());
	process.exit(1);
}

// Remove the command token from args before command-specific parsing.
if (command !== "menu") {
	args.splice(args.indexOf(command), 1);
}

const parsed = command === "menu" ? {} : parseCommand(command, args);

if (parsed && parsed.unknown && parsed.unknown.length > 0) {
	console.error(`Unknown option(s) for '${command}': ${parsed.unknown.join(", ")}`);
	console.error(formatCommandHelp(command));
	process.exit(1);
}

const validationPlan =
	command === "menu" ? { enabled: false, profile: "none", verifyHash: false } : toCheckMode(parsed);

// --- Standalone validator command (no Telegram auth required) ---
if (command === "valid") {
	const { runValidation } = require("./validators");
	const logger = require("./utils/logger");
	const options = toValidationOptions(parsed);
	logger.init();
	runValidation(options)
		.then(() => {
			logger.close();
			process.exit(0);
		})
		.catch((err) => {
			logger.writeSync("error", `[VALID] Validation failed: ${err?.stack || err?.message || String(err)}`);
			console.error(`Validation failed: ${err.message}`);
			logger.close();
			process.exit(1);
		});
	return;
}

// --- Local utility commands (no Telegram auth required) ---
if (command === "snapshot" || command === "export" || command === "restore") {
	const logger = require("./utils/logger");
	logger.init();

	const runUtility = async () => {
		if (command === "snapshot") {
			const { createSnapshots } = require("./utils/save_files");
			const { resolveExportDir } = require("./utils/cli_utils");
			return createSnapshots(resolveExportDir(parsed.positionals[0]));
		}
		if (command === "export") {
			const { main } = require("./utils/export_messages");
			const { resolveExportDir } = require("./utils/cli_utils");
			return main(resolveExportDir(parsed.positionals[0]));
		}
		// restore
		const { restoreAll, restoreQuarantineForChannel } = require("./utils/restore_quarantine");
		const channels = parsed.positionals;
		if (channels.length > 0) {
			for (const channelId of channels) {
				restoreQuarantineForChannel(channelId);
			}
			return 0;
		}
		restoreAll();
		return 0;
	};

	runUtility()
		.then((exitCode) => {
			const db = require("./utils/db");
			db.closeAllConnections();
			logger.close();
			process.exit(typeof exitCode === "number" ? exitCode : 0);
		})
		.catch((err) => {
			logger.writeSync(
				"error",
				`[${command.toUpperCase()}] Failed: ${err?.stack || err?.message || String(err)}`,
			);
			console.error(err);
			const db = require("./utils/db");
			db.closeAllConnections();
			logger.close();
			process.exit(1);
		});
	return;
}

const {
	getMessages,
	startChannelListener,
	downloadMessagesByIds,
	rebuildDatabaseFromApi,
} = require("./modules/messages");
const { getLastSelection } = require("./utils/file_helper");
const { initAuth } = require("./modules/auth");
const { searchDialog, selectDialog, getDialogName, getAllDialogs } = require("./modules/dialoges");
const { logMessage } = require("./utils/helper");
const logger = require("./utils/logger");
const db = require("./utils/db");
const { cancelAllDownloads } = require("./services/DownloadManager");

logger.init();

let client = null;
let shutdownInProgress = false;
let listenerTeardown = null;

const shutdown = async (exitCode, reason = null) => {
	// Re-entrancy guard. Must still return a Promise so callers can safely
	// chain `.catch()` even when shutdown is already running (otherwise a
	// second signal/rejection during shutdown would throw `undefined.catch`).
	if (shutdownInProgress) {
		return;
	}

	shutdownInProgress = true;

	if (reason) {
		logger.writeSync("info", reason);
	}

	cancelAllDownloads();

	if (typeof listenerTeardown === "function") {
		try {
			listenerTeardown();
		} catch (error) {
			logger.writeSync("error", `[MAIN] Failed to tear down listener: ${error?.message || String(error)}`);
		}
		listenerTeardown = null;
	}

	if (client && typeof client.disconnect === "function") {
		try {
			await client.disconnect();
		} catch (error) {
			logger.writeSync(
				"error",
				`[MAIN] Failed to disconnect Telegram client: ${error?.message || String(error)}`,
			);
		}
	}

	try {
		db.closeAllConnections();
	} catch (error) {
		logger.writeSync("error", `[MAIN] Failed to close database connections: ${error?.message || String(error)}`);
	}

	logger.close();
	process.exit(exitCode);
};

process.on("SIGINT", () => {
	shutdown(130, "Process interrupted (SIGINT), shutting down...").catch((error) => {
		logger.writeSync("error", `[MAIN] Shutdown failed after SIGINT: ${error?.message || String(error)}`);
		logger.close();
		process.exit(130);
	});
});

process.on("SIGTERM", () => {
	shutdown(143, "Process terminated (SIGTERM), shutting down...").catch((error) => {
		logger.writeSync("error", `[MAIN] Shutdown failed after SIGTERM: ${error?.message || String(error)}`);
		logger.close();
		process.exit(143);
	});
});

process.on("uncaughtException", (err) => {
	const msg = `[FATAL] Uncaught exception: ${err?.message || String(err)}\n${err?.stack || ""}`;
	logger.writeSync("error", msg);
	shutdown(1).catch(() => {
		logger.close();
		process.exit(1);
	});
});

process.on("unhandledRejection", (reason) => {
	const msg = `[FATAL] Unhandled rejection: ${reason?.message || String(reason)}\n${reason?.stack || ""}`;
	logger.writeSync("error", msg);
	shutdown(1).catch(() => {
		logger.close();
		process.exit(1);
	});
});

const { booleanInput, downloadOptionInput, textInput, selectInput } = require("./utils/input_helper");

// --- Main Menu ---
const showMainMenu = async () => {
	const choices = [
		{ name: "Full Download (All messages with media)", value: "download" },
		{ name: "Rebuild DB From API (No media download)", value: "rebuild-db" },
		{ name: "Real-time Monitor (Listen for new messages)", value: "listen" },
		{ name: "Download by IDs (Specific message IDs)", value: "ids" },
		{ name: "Run File Validators", value: "valid" },
		{ name: "Exit", value: "exit" },
	];

	return await selectInput("Select an action:", choices);
};

// --- Search or List Channel ---
const searchOrListChannel = async (dialogs) => {
	const wantToSearch = await booleanInput("Do you want to search for a channel?", false);
	if (wantToSearch) {
		await searchDialog(dialogs);
	} else {
		await selectDialog(dialogs);
	}
};

const promptChannelSelection = async () => {
	const dialogs = await getAllDialogs(client, true, appPaths);
	await searchOrListChannel(dialogs);
	const sel = getLastSelection();
	if (!sel.channelId) {
		logMessage.error("Channel was not selected");
	}
	return sel.channelId;
};

/**
 * Unified channel resolution shared by every interactive flow.
 * @param {number|null} chId - channel id from CLI (already resolved), if any
 * @param {object} [opts]
 * @param {boolean} [opts.confirmChange] - when a CLI id is provided, ask whether to switch
 * @returns {Promise<number|null>}
 */
const selectChannel = async (chId, { confirmChange = false } = {}) => {
	if (chId) {
		logMessage.success(`Selected channel is: ${await getDialogName(client, chId, appPaths)}`);
		if (confirmChange && (await booleanInput("Do you want to change channel?", false))) {
			return await promptChannelSelection();
		}
		return chId;
	}

	const lastSelection = getLastSelection();
	if (lastSelection.channelId) {
		const lastChannelName = await getDialogName(client, lastSelection.channelId, appPaths);
		logMessage.info(`Last selected channel: ${lastChannelName || lastSelection.channelId}`);
		const useLastChannel = await booleanInput("Do you want to continue with this channel?", true);
		if (useLastChannel) {
			logMessage.success(`Continuing with channel: ${lastChannelName || lastSelection.channelId}`);
			return lastSelection.channelId;
		}
		return await promptChannelSelection();
	}

	return await promptChannelSelection();
};

const assertClientReady = (action) => {
	if (!client || typeof client.getMessages !== "function") {
		logMessage.error(`Client is not properly initialized for ${action}`);
		return false;
	}
	return true;
};

// --- Download Full Channel ---
const runFullDownload = async (chId) => {
	const selectedChannelId = await selectChannel(chId, { confirmChange: true });
	if (!selectedChannelId) {
		logMessage.error("Channel was not selected");
		return;
	}

	const filesToDownload = await downloadOptionInput();

	if (!assertClientReady("download")) {
		return;
	}

	await getMessages(client, selectedChannelId, filesToDownload, {
		...appPaths,
		validationProfile: validationPlan.profile,
		verifyHash: validationPlan.verifyHash,
	});
};

const runDatabaseRebuild = async (chId) => {
	const selectedChannelId = await selectChannel(chId);
	if (!selectedChannelId) {
		logMessage.error("Channel was not selected");
		return;
	}

	if (!assertClientReady("DB rebuild")) {
		return;
	}

	// Warm up Telegram entity cache so direct numeric IDs can be resolved.
	await getAllDialogs(client, true, appPaths);

	await rebuildDatabaseFromApi(client, selectedChannelId, appPaths);
};

// --- Download by IDs ---
const runDownloadByIds = async (chId, messageIds) => {
	let channelIdNum = chId;
	if (!channelIdNum) {
		channelIdNum = Number(await textInput("Please Enter Channel ID: "));
	}
	if (!channelIdNum) {
		logMessage.error("Invalid Channel ID");
		return;
	}

	let ids = messageIds;
	if (!ids || ids.length === 0) {
		const messageIdsText = await textInput("Please Enter Message Id(s) (separated by comma): ");
		ids = messageIdsText
			.split(",")
			.map(Number)
			.filter((id) => !isNaN(id));
	}

	if (!ids || ids.length === 0) {
		logMessage.error("No valid message IDs provided");
		return;
	}

	await downloadMessagesByIds(client, channelIdNum, ids, appPaths);
};

// --- Auto mode: skip all prompts, use last channel or provided channelId ---
const runAutoMode = async (channelIdOverride) => {
	let selectedChannelId = channelIdOverride;

	if (!selectedChannelId) {
		const lastSelection = getLastSelection();
		if (lastSelection.channelId) {
			selectedChannelId = lastSelection.channelId;
			logMessage.success(`[AUTO] Using last channel: ${selectedChannelId}`);
		} else {
			logMessage.error(
				`[AUTO] No channel ID provided and no last selection found. Use: ${process.pkg ? path.basename(process.execPath) : "node index.js"} download --auto --channel <channelId>`,
			);
			return;
		}
	} else {
		logMessage.success(`[AUTO] Using channel: ${selectedChannelId}`);
	}

	const filesToDownload = {
		webpage: true,
		poll: true,
		geo: true,
		contact: true,
		venue: true,
		sticker: true,
		image: true,
		video: true,
		audio: true,
		pdf: true,
	};

	await getMessages(client, selectedChannelId, filesToDownload, {
		...appPaths,
		validationProfile: validationPlan.profile,
		verifyHash: validationPlan.verifyHash,
	});
};

const runListener = async (chId) => {
	listenerTeardown = await startChannelListener(client, chId || null, appPaths);
	logMessage.info("Listening for new messages... Press Ctrl+C to stop.");
	// Block here until a signal triggers the global SIGINT/SIGTERM handler,
	// which runs shutdown() (which calls listenerTeardown).
	await new Promise(() => {});
};

// Main Entry Point
(async () => {
	try {
		client = await initAuth();

		// Direct (non-interactive) command dispatch.
		switch (command) {
			case "download":
				if (parsed.auto) {
					await runAutoMode(parsed.channel);
				} else {
					await runFullDownload(parsed.channel);
				}
				await shutdown(0);
				return;

			case "rebuild-db":
				await runDatabaseRebuild(parsed.channel);
				await shutdown(0);
				return;

			case "listen":
				await runListener(parsed.channel);
				return;

			case "ids":
				await runDownloadByIds(parsed.channel, parsed.messages);
				await shutdown(0);
				return;

			default:
				break;
		}

		// Interactive menu.
		const choice = await showMainMenu();

		switch (choice) {
			case "download":
				await runFullDownload(null);
				break;

			case "rebuild-db":
				await runDatabaseRebuild(null);
				break;

			case "listen":
				await runListener(null);
				break;

			case "ids":
				await runDownloadByIds(null, null);
				break;

			case "valid": {
				const { runValidation } = require("./validators");
				await runValidation({
					type: "all",
					deep: validationPlan.profile === "full" || validationPlan.profile === "strict",
					strict: validationPlan.profile === "strict",
				});
				break;
			}

			case "exit":
				logMessage.info("Exiting...");
				break;

			default:
				logMessage.error("Unknown option selected");
		}

		await shutdown(0);
	} catch (err) {
		const errorText = err?.stack || err?.message || String(err);
		logger.writeSync("error", `[MAIN] Unhandled error: ${errorText}`);
		console.error(err);
		await shutdown(1);
	}
})();
