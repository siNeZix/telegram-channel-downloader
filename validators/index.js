const fs = require("fs");
const path = require("path");
const { scanExportDirectory } = require("./file_scanner");
const { isFFmpegAvailable, getFFmpegPaths, validateFiles } = require("./ffmpeg_validator");

const MAX_PARALLEL = 10;

const consoleColors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    reset: "\x1b[0m"
};

const log = {
    info: (msg) => console.log(`📢: ${consoleColors.cyan} ${msg} ${consoleColors.reset}`),
    success: (msg) => console.log(`✅ ${consoleColors.green} ${msg} ${consoleColors.reset}`),
    error: (msg) => console.log(`❌ ${consoleColors.red} ${msg} ${consoleColors.reset}`),
    warn: (msg) => console.log(`⚠️ ${consoleColors.yellow} ${msg} ${consoleColors.reset}`),
    dryrun: (msg) => console.log(`🔸 [DRY-RUN] ${msg}`),
    deleted: (msg) => console.log(`🗑️ [DELETED] ${msg}`)
};

/**
 * Format bytes to human readable
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

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
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    process.stdout.write(`\r[${bar}] ${percent}% (${current}/${total})`);
}

/**
 * Delete a file
 * @param {string} filePath
 * @returns {boolean}
 */
function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (err) {
        log.error(`Failed to delete ${filePath}: ${err.message}`);
        return false;
    }
}

/**
 * Run validation
 * @param {Object} options
 * @param {boolean} options.dryRun - Don't delete, just report
 * @param {boolean} options.verbose - Show detailed output
 * @param {string} options.exportPath - Path to export directory
 * @param {string} options.type - 'all', 'image', or 'video'
 */
async function runValidation(options = {}) {
    const {
        dryRun = false,
        verbose = false,
        exportPath = path.join(__dirname, "..", "export"),
        type = "all"
    } = options;

    const startTime = Date.now();
    let totalScanned = 0;
    let totalValid = 0;
    let totalInvalid = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    let deletedEntries = [];
    let errorEntries = [];

    log.info(`Starting file validation...`);
    if (dryRun) {
        log.warn(`DRY-RUN MODE: No files will be deleted`);
    }

    // Check ffmpeg availability
    log.info(`Checking ffmpeg availability...`);
    const ffmpegAvailable = await isFFmpegAvailable();
    if (!ffmpegAvailable) {
        log.error(`ffmpeg/ffprobe not found in PATH. Please install ffmpeg first.`);
        process.exit(1);
    }

    const ffmpegPaths = await getFFmpegPaths();
    log.success(`Found ffmpeg: ${ffmpegPaths.ffmpeg}`);
    log.success(`Found ffprobe: ${ffmpegPaths.ffprobe}`);

    // Check export directory
    if (!fs.existsSync(exportPath)) {
        log.error(`Export directory not found: ${exportPath}`);
        process.exit(1);
    }

    // Scan for files
    log.info(`Scanning export directory: ${exportPath}`);
    let files = scanExportDirectory(exportPath);
    totalScanned = files.length;

    if (files.length === 0) {
        log.warn(`No media files found in export directory`);
        return;
    }

    log.success(`Found ${totalScanned} media files`);

    // Filter by type if specified
    if (type !== "all") {
        files = files.filter(f => f.type === type);
        log.info(`Filtered to ${files.length} ${type} files`);
    }

    // Process files
    log.info(`Validating files (max ${MAX_PARALLEL} parallel)...`);

    let lastProgressUpdate = Date.now();
    const PROGRESS_UPDATE_INTERVAL = 500;

    const progressCallback = (file, result) => {
        const now = Date.now();

        if (verbose || now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
            printProgress(totalValid + totalInvalid + totalErrors, files.length);
            lastProgressUpdate = now;
        }

        if (!result.valid) {
            totalInvalid++;
            errorEntries.push({
                path: file.relativePath,
                size: file.size,
                error: result.error,
                timestamp: new Date().toISOString()
            });

            if (dryRun) {
                log.dryrun(`Would delete: ${file.relativePath} (${formatBytes(file.size)}) - ${result.error}`);
            } else {
                const deleted = deleteFile(file.path);
                if (deleted) {
                    totalDeleted++;
                    deletedEntries.push({
                        path: file.relativePath,
                        size: file.size,
                        reason: result.error,
                        timestamp: new Date().toISOString()
                    });
                    log.deleted(`${file.relativePath} (${formatBytes(file.size)}) - ${result.error}`);
                }
            }
        } else {
            totalValid++;
            if (verbose) {
                log.success(`Valid: ${file.relativePath}`);
            }
        }
    };

    await validateFiles(files, ffmpegPaths, progressCallback, MAX_PARALLEL);

    // Clear progress line
    process.stdout.write("\r" + " ".repeat(80) + "\r");

    // Print summary
    console.log("\n" + "=".repeat(50));
    log.info(`=== Validation Complete ===`);
    console.log("=".repeat(50));
    log.info(`Scanned:  ${totalScanned} files`);
    log.success(`Valid:   ${totalValid} files`);
    log.error(`Invalid: ${totalInvalid} files`);
    if (dryRun) {
        log.warn(`Would delete: ${totalInvalid} files`);
    } else {
        log.info(`Deleted: ${totalDeleted} files`);
    }
    log.info(`Errors:  ${totalErrors}`);
    log.info(`Duration: ${formatDuration((Date.now() - startTime) / 1000)}`);
    console.log("=".repeat(50));

    return {
        totalScanned,
        totalValid,
        totalInvalid,
        totalDeleted,
        errors: totalErrors
    };
}

/**
 * Escape path for Windows command line
 * @param {string} filePath
 * @returns {string}
 */
function escapePathForCmd(filePath) {
    // Replace single quotes with double quotes for Windows
    let escaped = filePath.replace(/'/g, "''");
    // Wrap in double quotes
    return `"${escaped}"`;
}

/**
 * Parse command line arguments
 * @returns {Object}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        dryRun: false,
        verbose: false,
        type: "all",
        exportPath: null
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
        } else if (!arg.startsWith("-")) {
            // Positional argument - treat as export path
            options.exportPath = path.resolve(arg);
        }
    }

    return options;
}

module.exports = {
    runValidation,
    parseArgs,
    isFFmpegAvailable,
    escapePathForCmd
};

// Run if executed directly
if (require.main === module) {
    const options = parseArgs();
    runValidation(options)
        .then((result) => {
            process.exit(result && result.totalInvalid > 0 && !options.dryRun ? 0 : 0);
        })
        .catch((err) => {
            log.error(`Validation failed: ${err.message}`);
            process.exit(1);
        });
}
