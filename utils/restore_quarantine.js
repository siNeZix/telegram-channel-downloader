const fs = require("fs");
const path = require("path");
const db = require("./db");
const paths = require("./paths");
const logger = require("./logger");
const { logMessage } = require("./helper");

function restoreQuarantineForChannel(channelId) {
	const quarantineDir = paths.getQuarantinePath(channelId);
	const outputFolder = paths.getChannelExportPath(channelId);

	if (!fs.existsSync(quarantineDir)) {
		logMessage.info(`[RESTORE] Quarantine directory not found: ${quarantineDir}`);
		return { restored: 0, errors: 0, skipped: 0 };
	}

	const entries = fs.readdirSync(quarantineDir);
	const metaFiles = entries.filter((f) => f.endsWith(".json"));

	if (metaFiles.length === 0) {
		logMessage.info(`[RESTORE] No quarantine metadata files found in ${quarantineDir}`);
		return { restored: 0, errors: 0, skipped: 0 };
	}

	logMessage.info(`[RESTORE] Found ${metaFiles.length} quarantined files in channel ${channelId}`);

	let restored = 0;
	let errors = 0;
	let skipped = 0;

	for (const metaFile of metaFiles) {
		const metaPath = path.join(quarantineDir, metaFile);
		const filePath = metaPath.replace(/\.json$/, "");

		let meta;
		try {
			meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
		} catch (e) {
			logMessage.error(`[RESTORE] Failed to read metadata ${metaFile}: ${e.message}`);
			errors++;
			continue;
		}

		if (!meta.originalPath) {
			logMessage.warn(`[RESTORE] No originalPath in ${metaFile}, skipping`);
			skipped++;
			continue;
		}

		// Guard against path traversal: the originalPath comes from an untrusted
		// JSON sidecar and must resolve inside this channel's export folder.
		const resolvedOriginal = path.resolve(meta.originalPath);
		const resolvedRoot = path.resolve(outputFolder);
		if (resolvedOriginal !== resolvedRoot && !resolvedOriginal.startsWith(resolvedRoot + path.sep)) {
			logMessage.error(
				`[RESTORE] Refusing to restore outside channel folder: ${meta.originalPath} (channel root: ${resolvedRoot})`,
			);
			errors++;
			continue;
		}

		if (!fs.existsSync(filePath)) {
			logMessage.warn(`[RESTORE] Quarantined file missing: ${filePath}`);
			errors++;
			continue;
		}

		const originalDir = path.dirname(meta.originalPath);
		paths.ensureDir(originalDir);

		if (fs.existsSync(meta.originalPath)) {
			logMessage.warn(`[RESTORE] Original file already exists, overwriting: ${meta.originalPath}`);
		}

		try {
			fs.renameSync(filePath, meta.originalPath);
		} catch (e) {
			if (e.code === "EXDEV") {
				try {
					fs.copyFileSync(filePath, meta.originalPath);
					fs.unlinkSync(filePath);
				} catch (e2) {
					logMessage.error(`[RESTORE] Copy+unlink failed for ${metaFile}: ${e2.message}`);
					errors++;
					continue;
				}
			} else {
				logMessage.error(`[RESTORE] Failed to move ${metaFile}: ${e.message}`);
				errors++;
				continue;
			}
		}

		const messageId = extractMessageIdFromPath(meta.originalPath);
		if (messageId) {
			db.setFileDownloaded(channelId, outputFolder, messageId, 1);
			db.setValidationState(channelId, outputFolder, messageId, {
				status: null,
				profile: null,
				error: null,
				validatedAt: Date.now(),
			});
		}

		try {
			fs.unlinkSync(metaPath);
		} catch (e) {
			logMessage.warn(`[RESTORE] Failed to delete metadata ${metaFile}: ${e.message}`);
		}

		logMessage.success(`[RESTORE] Restored: ${path.basename(meta.originalPath)}`);
		restored++;
	}

	const remainingFiles = fs.readdirSync(quarantineDir).filter((f) => !f.endsWith(".json"));
	for (const orphan of remainingFiles) {
		const orphanPath = path.join(quarantineDir, orphan);
		const matchingMeta = orphan + ".json";
		if (!fs.existsSync(path.join(quarantineDir, matchingMeta))) {
			logMessage.warn(`[RESTORE] Orphan file without metadata: ${orphan}`);
			skipped++;
		}
	}

	return { restored, errors, skipped };
}

function extractMessageIdFromPath(filePath) {
	const basename = path.basename(filePath, path.extname(filePath));
	const match = basename.match(/^file_(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

function restoreAll() {
	const exportDir = paths.export;

	if (!fs.existsSync(exportDir)) {
		logMessage.info(`[RESTORE] Export directory not found: ${exportDir}`);
		return;
	}

	const channelDirs = fs.readdirSync(exportDir).filter((name) => {
		const fullPath = path.join(exportDir, name);
		const quarantinePath = path.join(fullPath, "quarantine");
		return fs.existsSync(quarantinePath);
	});

	if (channelDirs.length === 0) {
		console.log("[RESTORE] No quarantine directories found");
		return;
	}

	console.log(`[RESTORE] Found ${channelDirs.length} channel(s) with quarantine directories\n`);

	let totalRestored = 0;
	let totalErrors = 0;
	let totalSkipped = 0;

	for (const channelId of channelDirs) {
		logMessage.info(`[RESTORE] Processing channel ${channelId}...`);
		const result = restoreQuarantineForChannel(channelId);
		totalRestored += result.restored;
		totalErrors += result.errors;
		totalSkipped += result.skipped;
		logMessage.info(`  Restored: ${result.restored}, Errors: ${result.errors}, Skipped: ${result.skipped}`);
	}

	logMessage.success("=== RESTORE COMPLETE ===");
	logMessage.info(`Total restored: ${totalRestored}`);
	logMessage.info(`Total errors: ${totalErrors}`);
	logMessage.info(`Total skipped: ${totalSkipped}`);
}

if (require.main === module) {
	logger.init();
	try {
		const args = process.argv.slice(2);

		if (args.length > 0) {
			for (const channelId of args) {
				console.log(`[RESTORE] Restoring quarantine for channel ${channelId}...`);
				const result = restoreQuarantineForChannel(channelId);
				console.log(`  Restored: ${result.restored}, Errors: ${result.errors}, Skipped: ${result.skipped}\n`);
			}
		} else {
			restoreAll();
		}
	} catch (err) {
		logger.writeSync("error", `[RESTORE] Unhandled error: ${err?.stack || err?.message || String(err)}`);
		console.error(err);
		process.exitCode = 1;
	} finally {
		db.closeAllConnections();
		logger.close();
	}
}

module.exports = {
	restoreQuarantineForChannel,
	restoreAll,
	extractMessageIdFromPath,
};
