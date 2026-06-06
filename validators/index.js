const fs = require("fs");
const path = require("path");
const { scanExportDirectory } = require("./file_scanner");
const { isFFmpegAvailable, getFFmpegPaths, validateFile, validateVideoDeep } = require("./ffmpeg_validator");
const { loadSnapshots, logMessage } = require("../utils/helper");
const paths = require("../utils/paths");
const db = require("../utils/db");
const { ValidationService } = require("../services/ValidationService");

const MAX_PARALLEL = 10;

const log = {
	info: (msg) => {
		logMessage.info(`[VALID] ${msg}`);
	},
	success: (msg) => {
		logMessage.success(`[VALID] ${msg}`);
	},
	error: (msg) => {
		logMessage.error(`[VALID] ${msg}`);
	},
	warn: (msg) => {
		logMessage.warn(`[VALID] ${msg}`);
	},
	dryrun: (msg) => logMessage.info(`[DRY-RUN] ${msg}`),
	deleted: (msg) => logMessage.info(`[DELETED] ${msg}`),
};

/**
 * Format duration in seconds to mm:ss
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Print progress bar
 * @param {number} current
 * @param {number} total
 * @param {number} width
 */
function printProgress(current, total, width = 30) {
	const safeTotal = Math.max(total, 1);
	const percent = Math.min(Math.round((current / safeTotal) * 100), 100);
	const filled = Math.min(Math.round((current / safeTotal) * width), width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	process.stdout.write(`\r[${bar}] ${percent}% (${current}/${total})`);
}

/**
 * Extract message ID from file path
 * File naming convention: file_{messageId}[_optional.ext] or file_{messageId}_{originalName}
 * @param {string} filePath - Full file path
 * @returns {number|null} - Message ID or null if not found
 */
function extractMessageIdFromPath(filePath) {
	const basename = path.basename(filePath, path.extname(filePath));
	const match = basename.match(/^file_(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract channel ID from file path
 * Path structure: {exportPath}/{channelId}/{mediaType}/...
 * @param {string} filePath - Full file path
 * @param {string} exportPath - Export directory path
 * @returns {string|null} - Channel ID or null
 */
function extractChannelIdFromPath(filePath, exportPath) {
	const relativePath = path.relative(exportPath, filePath);
	const parts = relativePath.split(path.sep);
	return parts.length > 0 ? parts[0] : null;
}

async function quarantineFile(channelId, outputFolder, filePath, reason, metadata = {}) {
	const validationService = new ValidationService({ channelId, outputFolder, ffmpegPaths: null });
	return validationService.quarantineFile(filePath, reason, metadata);
}

function buildQuarantineMetadata(file, validationResult, extra = {}) {
	return {
		relativePath: file.relativePath,
		size: file.size,
		mediaType: file.type,
		extension: file.extension,
		validation: {
			status: validationResult?.status || "invalid",
			profile: validationResult?.profile || null,
			fileType: validationResult?.fileType || null,
			error: validationResult?.error || null,
			timedOut: !!validationResult?.timedOut,
			fatalErrors: validationResult?.fatalErrors || [],
			nonFatalErrors: validationResult?.nonFatalErrors || [],
			unknownErrors: validationResult?.unknownErrors || [],
		},
		...extra,
	};
}

/**
 * Run validation
 * @param {Object} options
 * @param {boolean} options.dryRun - Don't delete, just report
 * @param {boolean} options.verbose - Show detailed output
 * @param {string} options.exportPath - Path to export directory
 * @param {string} options.type - 'all', 'image', or 'video'
 * @param {boolean} options.deep - Use deep validation (full decode for video)
 * @param {boolean} options.cache - Use cache checking mode (verify against DB)
 */
async function runValidation(options = {}) {
	const {
		dryRun = false,
		verbose = false,
		exportPath = paths.export,
		type = "all",
		deep = false,
		strict = false,
		ignoreSnapshots = false,
		cache = false,
	} = options;

	logMessage.valid(
		`=== Starting file validation: dryRun=${dryRun}, verbose=${verbose}, type=${type}, deep=${deep}, strict=${strict}, cache=${cache}, exportPath=${exportPath} ===`,
	);

	const startTime = Date.now();
	let totalScanned = 0;
	let totalValid = 0;
	let totalInvalid = 0;
	let totalInconclusive = 0;
	let totalDeleted = 0;
	let totalSkipped = 0;
	let totalErrors = 0;
	let totalDbConfirmed = 0;
	let totalDbMissing = 0;
	let totalDbRecovered = 0;
	const deletedEntries = [];

	log.info(`Starting file validation...`);
	if (dryRun) {
		log.warn(`DRY-RUN MODE: No files will be deleted`);
	}
	if (cache) {
		log.info(`CACHE MODE: Checking files against database...`);
		if (deep || strict) {
			log.info(`DEEP VALIDATION: Will attempt to recover missing files`);
		}
	}

	try {
		// Load snapshots for all channels if not ignored
		const snapshotsByChannel = new Map();
		if (!ignoreSnapshots) {
			log.info(`Loading snapshots to skip pre-validated files...`);
			logMessage.valid(`[VALID] Loading snapshots from export directory: ${exportPath}`);

			const entries = fs.readdirSync(exportPath, { withFileTypes: true });
			let totalSnapshotEntries = 0;

			for (const entry of entries) {
				if (entry.isDirectory() && entry.name !== "snapshots" && entry.name !== "quarantine") {
					const channelPath = path.join(exportPath, entry.name);
					db.initDatabase(entry.name, channelPath);
					const snapshots = loadSnapshots(channelPath);
					if (snapshots.size > 0) {
						snapshotsByChannel.set(channelPath, snapshots);
						totalSnapshotEntries += snapshots.size;
						log.info(`Loaded ${snapshots.size} snapshot entries for '${entry.name}'`);
					}
				}
			}
			logMessage.valid(
				`[VALID] Loaded ${totalSnapshotEntries} total snapshot entries across ${snapshotsByChannel.size} channels`,
			);
		} else {
			logMessage.valid(`[VALID] Ignoring snapshots (ignoreSnapshots=true)`);
		}

		// Check ffmpeg availability
		log.info(`Checking ffmpeg availability...`);
		logMessage.valid(`[VALID] Checking ffmpeg availability`);

		const ffmpegAvailable = await isFFmpegAvailable();
		if (!ffmpegAvailable) {
			log.error(`ffmpeg/ffprobe not found in PATH. Please install ffmpeg first.`);
			throw new Error("ffmpeg not found in PATH");
		}

		const ffmpegPaths = await getFFmpegPaths();
		log.success(`Found ffmpeg: ${ffmpegPaths.ffmpeg}`);
		log.success(`Found ffprobe: ${ffmpegPaths.ffprobe}`);
		logMessage.valid(`[VALID] ffmpeg: ${ffmpegPaths.ffmpeg}, ffprobe: ${ffmpegPaths.ffprobe}`);
		const validationService = new ValidationService({ ffmpegPaths });

		// Check export directory
		if (!fs.existsSync(exportPath)) {
			log.error(`Export directory not found: ${exportPath}`);
			throw new Error(`Export directory not found: ${exportPath}`);
		}

		// Scan for files
		log.info(`Scanning export directory: ${exportPath}`);
		logMessage.valid(`[VALID] Scanning directory: ${exportPath}`);

		const scanStart = Date.now();
		let files = scanExportDirectory(exportPath);
		const scanTime = Date.now() - scanStart;
		totalScanned = files.length;

		logMessage.valid(`[VALID] Scan complete: found ${totalScanned} files in ${scanTime}ms`);

		if (files.length === 0) {
			log.warn(`No media files found in export directory`);
			return;
		}

		log.success(`Found ${totalScanned} media files`);

		// Filter by type if specified
		if (type !== "all") {
			const oldCount = files.length;
			files = files.filter((f) => f.type === type);
			log.info(`Filtered to ${files.length} ${type} files`);
			logMessage.valid(`[VALID] Type filter: ${type}, filtered ${oldCount} -> ${files.length}`);
		}

		// CACHE MODE: Process files against database
		if (cache) {
			log.info(`Processing files in CACHE mode...`);
			logMessage.valid(`[VALID] Cache mode processing: ${files.length} files`);

			const cacheStart = Date.now();
			let processedCount = 0;

			// Helper function to check snapshots
			const isInSnapshot = (file) => {
				if (snapshotsByChannel.size === 0) return false;

				for (const [channelPath, snapshots] of snapshotsByChannel) {
					if (file.path.startsWith(channelPath)) {
						const channelName = path.basename(channelPath);
						const relativeToChannel = file.relativePath.substring(channelName.length + 1);
						if (snapshots.has(relativeToChannel)) {
							return true;
						}
					}
				}
				return false;
			};

			// Process each file
			for (const file of files) {
				processedCount++;

				// Check if file is in snapshot - skip if so
				if (isInSnapshot(file)) {
					totalSkipped++;
					logMessage.cache(`[CACHE] Skipped (snapshot): ${file.relativePath}`);
					if (verbose) {
						printProgress(processedCount, files.length);
					}
					continue;
				}

				// Extract IDs from path
				const channelId = extractChannelIdFromPath(file.path, exportPath);
				const messageId = extractMessageIdFromPath(file.path);

				if (!channelId || !messageId) {
					logMessage.warn(
						`[CACHE] Cannot extract IDs from path: ${file.relativePath}, channelId=${channelId}, msgId=${messageId}`,
					);
					totalErrors++;
					continue;
				}

				// Check database for downloaded status
				const outputFolder = path.join(exportPath, channelId);
				const isDownloaded = db.isFileDownloaded(channelId, outputFolder, messageId);

				if (isDownloaded) {
					// File is marked as downloaded in DB - confirm it's valid
					totalDbConfirmed++;
					logMessage.cache(`[CACHE] DB confirmed: ${file.relativePath}`);
					if (verbose) {
						log.success(`DB OK: ${file.relativePath}`);
					}
				} else {
					// File NOT in DB as downloaded - it's corrupt/missing from DB
					totalDbMissing++;
					logMessage.warn(`[CACHE] DB missing: ${file.relativePath} (not marked as downloaded)`);

					if ((deep || strict) && fs.existsSync(file.path)) {
						// DEEP mode: try to validate with FFmpeg
						logMessage.info(`[CACHE] Running deep validation for: ${file.relativePath}`);

						const expectedSize = db.getExpectedSize(channelId, outputFolder, messageId);
						const validationResult = await validationService.validateMediaFile(file.path, file.type, {
							deepValidation: true,
							profile: strict ? "strict" : null,
							expectedSize,
						});

						if (validationResult.valid) {
							// File is actually valid! Recover it by updating DB
							logMessage.success(`[CACHE] File is valid, recovering: ${file.relativePath}`);
							db.setFileDownloaded(channelId, outputFolder, messageId, 1);
							db.setValidationState(channelId, outputFolder, messageId, {
								status: "verified",
								profile: validationResult.profile || (strict ? "strict" : "full"),
								error: null,
							});
							totalDbRecovered++;
						} else if (validationResult.status === "inconclusive") {
							logMessage.warn(
								`[CACHE] File validation inconclusive, keeping in place: ${file.relativePath}`,
							);
							db.setValidationState(channelId, outputFolder, messageId, {
								status: "inconclusive",
								profile: validationResult.profile,
								error: validationResult.error,
							});
							totalInconclusive++;
						} else {
							// File is corrupt - delete it
							logMessage.warn(`[CACHE] File failed validation, quarantining: ${file.relativePath}`);
							if (dryRun) {
								log.dryrun(`Would quarantine (not in DB, invalid): ${file.relativePath}`);
							} else {
								const quarantined = await quarantineFile(
									channelId,
									outputFolder,
									file.path,
									"not in DB + deep validation failed",
									buildQuarantineMetadata(file, validationResult),
								);
								if (quarantined?.ok) {
									totalDeleted++;
									deletedEntries.push({
										path: file.relativePath,
										size: file.size,
										reason: "not in DB + deep validation failed",
										timestamp: new Date().toISOString(),
									});
									log.deleted(`${file.relativePath} (not in DB, invalid)`);
								} else if (quarantined) {
									totalErrors++;
									log.error(`Quarantine failed: ${file.relativePath} - ${quarantined.error}`);
								}
							}
						}
					} else {
						// Not in deep mode - run fast ffprobe check before quarantining
						if (fs.existsSync(file.path)) {
							logMessage.info(`[CACHE] File not in DB, running ffprobe check: ${file.relativePath}`);

							const ffprobeCheck = await validationService.validateMediaFile(file.path, file.type, {
								deepValidation: false,
								profile: strict ? "strict" : null,
								expectedSize: db.getExpectedSize(channelId, outputFolder, messageId),
							});

							if (ffprobeCheck.valid) {
								logMessage.success(`[CACHE] File is valid (ffprobe), recovering: ${file.relativePath}`);
								db.setFileDownloaded(channelId, outputFolder, messageId, 1);
								db.setValidationState(channelId, outputFolder, messageId, {
									status: "verified",
									profile: ffprobeCheck.profile,
									error: null,
								});
								totalDbRecovered++;
							} else if (ffprobeCheck.status === "inconclusive") {
								logMessage.warn(
									`[CACHE] File validation inconclusive, keeping in place: ${file.relativePath}`,
								);
								db.setValidationState(channelId, outputFolder, messageId, {
									status: "inconclusive",
									profile: ffprobeCheck.profile,
									error: ffprobeCheck.error,
								});
								totalInconclusive++;
							} else {
								logMessage.warn(
									`[CACHE] File not in DB and ffprobe failed, quarantining: ${file.relativePath}`,
								);
								if (dryRun) {
									log.dryrun(`Would quarantine (not in DB, invalid): ${file.relativePath}`);
								} else {
									const quarantined = await quarantineFile(
										channelId,
										outputFolder,
										file.path,
										`not in DB + ${ffprobeCheck.error}`,
										buildQuarantineMetadata(file, ffprobeCheck),
									);
									if (quarantined?.ok) {
										totalDeleted++;
										deletedEntries.push({
											path: file.relativePath,
											size: file.size,
											reason: `not in DB + ${ffprobeCheck.error}`,
											timestamp: new Date().toISOString(),
										});
										log.deleted(`${file.relativePath} (not in DB, invalid)`);
									} else if (quarantined) {
										totalErrors++;
										log.error(`Quarantine failed: ${file.relativePath} - ${quarantined.error}`);
									}
								}
							}
						} else {
							logMessage.info(`[CACHE] File not in DB and doesn't exist on disk: ${file.relativePath}`);
						}
					}
				}

				if (verbose || processedCount % 100 === 0) {
					printProgress(processedCount, files.length);
				}
			}

			const cacheTime = Date.now() - cacheStart;
			process.stdout.write("\r" + " ".repeat(80) + "\r");

			const infoLine =
				`=== Cache Validation Complete ===\n${"=".repeat(50)}\n` +
				`Scanned:       ${totalScanned} files\n` +
				(totalSkipped > 0 ? `Skipped:       ${totalSkipped} files (from snapshots)\n` : "") +
				`DB Confirmed:  ${totalDbConfirmed} files\n` +
				`DB Missing:     ${totalDbMissing} files\n` +
				(totalInconclusive > 0 ? `Inconclusive:   ${totalInconclusive} files (kept in place)\n` : "") +
				(deep ? `DB Recovered:   ${totalDbRecovered} files (validated and updated)\n` : "") +
				`Quarantined:   ${totalDeleted} files\n` +
				(dryRun ? `DRY-RUN: No files were actually deleted\n` : "") +
				`Duration:      ${formatDuration((Date.now() - startTime) / 1000)}\n` +
				"=".repeat(50);
			logMessage.info(infoLine);

			logMessage.valid(
				`=== Cache summary: total=${totalScanned}, skipped=${totalSkipped}, dbConfirmed=${totalDbConfirmed}, dbMissing=${totalDbMissing}, dbRecovered=${totalDbRecovered}, inconclusive=${totalInconclusive}, deleted=${totalDeleted}, durationMs=${cacheTime} ===`,
			);

			return {
				totalScanned,
				totalValid: totalDbConfirmed,
				totalInvalid: totalDbMissing,
				totalInconclusive,
				totalDeleted,
				totalSkipped,
				totalDbConfirmed,
				totalDbMissing,
				totalDbRecovered,
				errors: totalErrors,
			};
		}

		const validationStart = Date.now();
		let processedCount = 0;
		let activeIndex = 0;
		const workers = [];
		const workerCount = Math.min(MAX_PARALLEL, files.length);

		const worker = async () => {
			while (activeIndex < files.length) {
				const currentIndex = activeIndex++;
				const file = files[currentIndex];
				processedCount++;

				if (!ignoreSnapshots) {
					const channelId = extractChannelIdFromPath(file.path, exportPath);
					if (channelId) {
						const channelPath = path.join(exportPath, channelId);
						const snapshots = snapshotsByChannel.get(channelPath);
						const relativeToChannel = path.relative(channelPath, file.path);
						if (
							snapshots?.has(relativeToChannel) ||
							snapshots?.has(relativeToChannel.replace(/\\/g, "/"))
						) {
							totalSkipped++;
							if (verbose) {
								log.info(`Skipped snapshot: ${file.relativePath}`);
							}
							continue;
						}
					}
				}

				try {
					const channelId = extractChannelIdFromPath(file.path, exportPath);
					const messageId = extractMessageIdFromPath(file.path);
					const outputFolder = channelId ? path.join(exportPath, channelId) : null;
					const expectedSize =
						channelId && messageId ? db.getExpectedSize(channelId, outputFolder, messageId) : null;
					const result = await validationService.validateMediaFile(file.path, file.type, {
						deepValidation: deep,
						profile: strict ? "strict" : null,
						expectedSize,
					});

					if (result.valid) {
						totalValid++;
						if (channelId && messageId && outputFolder) {
							db.setValidationState(channelId, outputFolder, messageId, {
								status: "verified",
								profile: result.profile,
								error: null,
							});
						}
						if (verbose) {
							log.success(`Valid: ${file.relativePath}`);
						}
					} else if (result.status === "inconclusive") {
						totalInconclusive++;
						if (channelId && messageId && outputFolder) {
							db.setValidationState(channelId, outputFolder, messageId, {
								status: "inconclusive",
								profile: result.profile,
								error: result.error,
							});
						}
						if (verbose) {
							log.warn(`Inconclusive: ${file.relativePath} - ${result.error}`);
						}
					} else {
						totalInvalid++;
						if (dryRun) {
							log.dryrun(`Would quarantine: ${file.relativePath} - ${result.error}`);
						} else {
							const quarantineChannelId = channelId || "unknown";
							const quarantineOutputFolder = outputFolder || path.dirname(file.path);
							const quarantined = await quarantineFile(
								quarantineChannelId,
								quarantineOutputFolder,
								file.path,
								result.error || "validation failed",
								buildQuarantineMetadata(file, result),
							);
							if (quarantined?.ok) {
								totalDeleted++;
								deletedEntries.push({
									path: file.relativePath,
									size: file.size,
									reason: result.error || "validation failed",
									timestamp: new Date().toISOString(),
								});
								log.deleted(`${file.relativePath} (${result.error || "validation failed"})`);
							} else if (quarantined) {
								totalErrors++;
								log.error(`Quarantine failed: ${file.relativePath} - ${quarantined.error}`);
							}
						}
						if (!dryRun && channelId && messageId && outputFolder) {
							db.setFileDownloaded(channelId, outputFolder, messageId, 0);
							db.setValidationState(channelId, outputFolder, messageId, {
								status: "quarantined",
								profile: result.profile,
								error: result.error,
							});
						}
					}
				} catch (error) {
					totalErrors++;
					log.error(`Validation error: ${file.relativePath} - ${error.message}`);
				}

				if (verbose || processedCount % 100 === 0 || processedCount === files.length) {
					printProgress(processedCount, files.length);
				}
			}
		};

		for (let i = 0; i < workerCount; i++) {
			workers.push(worker());
		}
		await Promise.all(workers);
		process.stdout.write("\r" + " ".repeat(80) + "\r");
		logMessage.valid(
			`[VALID] File validation processed ${processedCount} files in ${Date.now() - validationStart}ms`,
		);

		const summaryLines = [
			`\n${"=".repeat(50)}`,
			`=== Validation Complete ===`,
			`${"=".repeat(50)}`,
			`Scanned:  ${totalScanned} files`,
			...(totalSkipped > 0 ? [`Skipped:  ${totalSkipped} files (from snapshots)`] : []),
			`Valid:   ${totalValid} files`,
			`Invalid: ${totalInvalid} files`,
			...(totalInconclusive > 0 ? [`Inconclusive: ${totalInconclusive} files (kept in place)`] : []),
			...(dryRun ? [`Would quarantine: ${totalInvalid} files`] : [`Quarantined: ${totalDeleted} files`]),
			`Errors:  ${totalErrors}`,
			`Duration: ${formatDuration((Date.now() - startTime) / 1000)}`,
			"=".repeat(50),
		];
		for (const line of summaryLines) {
			logMessage.info(line);
		}

		logMessage.valid(
			`=== Validation summary: total=${totalScanned}, valid=${totalValid}, invalid=${totalInvalid}, inconclusive=${totalInconclusive}, skipped=${totalSkipped}, deleted=${totalDeleted}, errors=${totalErrors}, duration=${formatDuration((Date.now() - startTime) / 1000)} ===`,
		);

		return {
			totalScanned,
			totalValid,
			totalInvalid,
			totalInconclusive,
			totalDeleted,
			totalSkipped,
			errors: totalErrors,
		};
	} finally {
		db.closeAllConnections();
	}
}

/**
 * Parse command line arguments
 * @returns {Object}
 */
function parseArgs() {
	const args = process.argv.slice(2);
	const takeOptionValue = (optionName) => {
		const optionIndex = args.indexOf(optionName);
		if (optionIndex === -1) {
			return undefined;
		}

		const optionValue = args[optionIndex + 1];
		args.splice(optionIndex, optionValue !== undefined ? 2 : 1);
		return optionValue;
	};

	const runtimeOptions = {
		root: takeOptionValue("--root"),
		exportDir: takeOptionValue("--export-dir"),
		configFile: takeOptionValue("--config-file"),
		logsDir: takeOptionValue("--logs-dir"),
	};

	paths.configure(runtimeOptions);
	const options = {
		dryRun: false,
		verbose: false,
		type: "all",
		deep: false,
		strict: false,
		ignoreSnapshots: false,
		cache: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run" || arg === "-d") {
			options.dryRun = true;
		} else if (arg === "--verbose" || arg === "-v") {
			options.verbose = true;
		} else if (arg === "--images" || arg === "-i") {
			options.type = "image";
		} else if (arg === "--videos" || arg === "-V") {
			options.type = "video";
		} else if (arg === "--audio" || arg === "-A") {
			options.type = "audio";
		} else if (arg === "--deep" || arg === "-D") {
			options.deep = true;
		} else if (arg === "--strict") {
			options.strict = true;
			options.deep = true;
		} else if (arg === "--ignore-snapshots" || arg === "-S") {
			options.ignoreSnapshots = true;
		} else if (arg === "--cache" || arg === "-c") {
			options.cache = true;
		} else if (!arg.startsWith("-")) {
			// Positional argument - treat as export path
			options.exportPath = path.isAbsolute(arg) ? arg : path.resolve(paths.root, arg);
		}
	}

	return options;
}

module.exports = {
	runValidation,
	parseArgs,
	isFFmpegAvailable,
	getFFmpegPaths,
	validateFile,
	validateVideoDeep,
};

// Run if executed directly
if (require.main === module) {
	const options = parseArgs();
	runValidation(options)
		.then((result) => {
			const logger = require("../utils/logger");
			logger.close();
			const exitCode = result && result.totalInvalid > 0 && !options.dryRun ? 1 : 0;
			if (exitCode !== 0) {
				process.exitCode = exitCode;
			}
		})
		.catch((err) => {
			log.error(`Validation failed: ${err.message}`);
			const logger = require("../utils/logger");
			logger.close();
			process.exitCode = 1;
		});
}
