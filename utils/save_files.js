const fs = require("fs");
const path = require("path");
const { scanDirectory, IGNORED_DIRS } = require("../validators/file_scanner");
const { logMessage } = require("./helper");
const logger = require("./logger");
const paths = require("./paths");

const SNAPSHOTS_DIR = "snapshots";

/**
 * Scan all channels in export directory and create snapshots
 */
function createSnapshots(exportDir = paths.export) {
    logMessage.info("Starting files snapshot creation...");

    if (!fs.existsSync(exportDir)) {
        logMessage.error(`Export directory not found: ${exportDir}`);
        return 1;
    }

    const entries = fs.readdirSync(exportDir, { withFileTypes: true });
    let totalChannels = 0;
    let totalFiles = 0;

    for (const entry of entries) {
        const channelPath = path.join(exportDir, entry.name);

        if (!entry.isDirectory()) {
            continue;
        }

        if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
            continue;
        }

        totalChannels++;
        const snapshotResult = createChannelSnapshot(entry.name, channelPath);
        totalFiles += snapshotResult.count;

        if (snapshotResult.count > 0) {
            logMessage.success(
                `Channel '${entry.name}': ${snapshotResult.count} files saved to ${snapshotResult.fileName}`
            );
        } else {
            logMessage.info(`Channel '${entry.name}': no files found (skipped)`);
        }
    }

    logMessage.success(
        `Snapshot creation complete. Total: ${totalFiles} files in ${totalChannels} channels.`
    );

    return 0;
}

/**
 * Create snapshot for a specific channel
 * @param {string} channelName - Name of the channel folder
 * @param {string} channelPath - Full path to the channel folder
 * @returns {{ count: number, fileName: string }}
 */
function createChannelSnapshot(channelName, channelPath) {
    const files = {};

    // Scan all subdirectories (image, video, etc.)
    const subEntries = fs.readdirSync(channelPath, { withFileTypes: true });

    for (const subEntry of subEntries) {
        const subPath = path.join(channelPath, subEntry.name);

        if (!subEntry.isDirectory()) {
            continue;
        }

        // scanDirectory will ignore 'snapshots' because we added it to IGNORED_DIRS
        const scannedFiles = scanDirectory(subPath, channelPath);

        for (const file of scannedFiles) {
            // Filter out empty files (size 0)
            if (file.size > 0) {
                files[file.relativePath] = file.size;
            }
        }
    }

    if (Object.keys(files).length === 0) {
        return { count: 0, fileName: null };
    }

    // Create snapshots directory if it doesn't exist
    const snapshotsPath = path.join(channelPath, SNAPSHOTS_DIR);
    if (!fs.existsSync(snapshotsPath)) {
        fs.mkdirSync(snapshotsPath, { recursive: true });
    }

    // Generate timestamp for filename
    const now = new Date();
    const timestamp = now
        .toISOString()
        .replace(/T/, "_")
        .replace(/:/g, "-")
        .replace(/\..+/, "");
    const fileName = `snapshot_${timestamp}.json`;
    const snapshotFilePath = path.join(snapshotsPath, fileName);

    // Write snapshot file
    const snapshotData = {
        version: 1,
        createdAt: now.toISOString(),
        files: files,
    };

    fs.writeFileSync(snapshotFilePath, JSON.stringify(snapshotData, null, 2));

    return { count: Object.keys(files).length, fileName: fileName };
}

// Run if executed directly
if (require.main === module) {
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

    paths.configure({
        root: takeOptionValue("--root"),
        exportDir: takeOptionValue("--export-dir"),
        configFile: takeOptionValue("--config-file"),
        logsDir: takeOptionValue("--logs-dir"),
    });

    const exportDirArg = args[0]
        ? path.resolve(args[0])
        : paths.export;
    logger.init();

    let exitCode = 0;
    try {
        exitCode = createSnapshots(exportDirArg);
    } finally {
        logger.close();
    }

    process.exit(exitCode);
}

module.exports = { createSnapshots };
