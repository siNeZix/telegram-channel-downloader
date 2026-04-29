const fs = require("fs");
const path = require("path");
const db = require("./db");
const paths = require("./paths");
const { logMessage } = require("./helper");

function restoreQuarantineForChannel(channelId) {
	const quarantineDir = paths.getQuarantinePath(channelId);
	const outputFolder = paths.getChannelExportPath(channelId);

	if (!fs.existsSync(quarantineDir)) {
		console.log(`[RESTORE] Quarantine directory not found: ${quarantineDir}`);
		return { restored: 0, errors: 0, skipped: 0 };
	}

	const entries = fs.readdirSync(quarantineDir);
	const metaFiles = entries.filter((f) => f.endsWith(".json"));

	if (metaFiles.length === 0) {
		console.log(`[RESTORE] No quarantine metadata files found in ${quarantineDir}`);
		return { restored: 0, errors: 0, skipped: 0 };
	}

	console.log(`[RESTORE] Found ${metaFiles.length} quarantined files in channel ${channelId}`);

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
			console.error(`[RESTORE] Failed to read metadata ${metaFile}: ${e.message}`);
			errors++;
			continue;
		}

		if (!meta.originalPath) {
			console.warn(`[RESTORE] No originalPath in ${metaFile}, skipping`);
			skipped++;
			continue;
		}

		if (!fs.existsSync(filePath)) {
			console.warn(`[RESTORE] Quarantined file missing: ${filePath}`);
			errors++;
			continue;
		}

		const originalDir = path.dirname(meta.originalPath);
		paths.ensureDir(originalDir);

		if (fs.existsSync(meta.originalPath)) {
			console.warn(`[RESTORE] Original file already exists, overwriting: ${meta.originalPath}`);
		}

		try {
			fs.renameSync(filePath, meta.originalPath);
		} catch (e) {
			if (e.code === "EXDEV") {
				try {
					fs.copyFileSync(filePath, meta.originalPath);
					fs.unlinkSync(filePath);
				} catch (e2) {
					console.error(`[RESTORE] Copy+unlink failed for ${metaFile}: ${e2.message}`);
					errors++;
					continue;
				}
			} else {
				console.error(`[RESTORE] Failed to move ${metaFile}: ${e.message}`);
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
			console.warn(`[RESTORE] Failed to delete metadata ${metaFile}: ${e.message}`);
		}

		console.log(`[RESTORE] Restored: ${path.basename(meta.originalPath)}`);
		restored++;
	}

	const remainingFiles = fs.readdirSync(quarantineDir).filter((f) => !f.endsWith(".json"));
	for (const orphan of remainingFiles) {
		const orphanPath = path.join(quarantineDir, orphan);
		const matchingMeta = orphan + ".json";
		if (!fs.existsSync(path.join(quarantineDir, matchingMeta))) {
			console.warn(`[RESTORE] Orphan file without metadata: ${orphan}`);
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
		console.log(`[RESTORE] Export directory not found: ${exportDir}`);
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
		console.log(`[RESTORE] Processing channel ${channelId}...`);
		const result = restoreQuarantineForChannel(channelId);
		totalRestored += result.restored;
		totalErrors += result.errors;
		totalSkipped += result.skipped;
		console.log(`  Restored: ${result.restored}, Errors: ${result.errors}, Skipped: ${result.skipped}\n`);
	}

	console.log("=== RESTORE COMPLETE ===");
	console.log(`Total restored: ${totalRestored}`);
	console.log(`Total errors: ${totalErrors}`);
	console.log(`Total skipped: ${totalSkipped}`);
}

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