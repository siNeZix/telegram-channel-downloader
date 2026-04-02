const fs = require("fs");
const path = require("path");
const { scanExportDirectory } = require("./file_scanner");
const { isFFmpegAvailable, getFFmpegPaths, validateFiles } = require("./ffmpeg_validator");

const LOG_FILE = "deleted_files.json";
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
    dryrun: (msg) => console.log(`🔸 [DRY-RUN] ${msg}`)
};

/**
 * Get path to deleted files log
 * @param {string} exportPath
 * @returns {string}
 */
function getDeletedFilesLogPath(exportPath) {
    return path.join(exportPath, LOG_FILE);
}

/**
 * Load existing deleted files log
 * @param {string} logPath
 * @returns {Array}
 */
function loadDeletedLog(logPath) {
    try {
        if (fs.existsSync(logPath)) {
            const data = fs.readFileSync(logPath, "utf-8");
            return JSON.parse(data);
        }
    } catch (err) {
        // Ignore
    }
    return [];
}

/**
 * Save deleted files log
 * @param {string} logPath
 * @param {Object} data
 */
function saveDeletedLog(logPath, data) {
    fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
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

    // Load existing log
    const logPath = getDeletedFilesLogPath(exportPath);
    const existingLog = loadDeletedLog(logPath);

    // Process files
    log.info(`Validating files (max ${MAX_PARALLEL} parallel)...`);

    let lastProgressUpdate = Date.now();
    const PROGRESS_UPDATE_INTERVAL = 500;

    const progressCallback = (validated, total, file, result) => {
        const now = Date.now();

        if (verbose || now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
            printProgress(validated, total);
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
                    if (verbose) {
                        log.dryrun(`Deleted: ${file.relativePath}`);
                    }
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

    // Save log
    const logEntry = {
        timestamp: new Date().toISOString(),
        dryRun,
        totalScanned,
        totalValid,
        totalInvalid,
        deleted: dryRun ? [] : deletedEntries,
        errors: errorEntries,
        duration: formatDuration((Date.now() - startTime) / 1000)
    };

    // Append to existing log
    const newLog = [...existingLog, logEntry];
    saveDeletedLog(logPath, newLog);

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
    log.info(`Duration: ${logEntry.duration}`);
    console.log("=".repeat(50));
    log.info(`Log saved to: ${logPath}`);

    return {
        totalScanned,
        totalValid,
        totalInvalid,
        totalDeleted,
        errors: totalErrors
    };
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
        type: "all"
    };

    for (const arg of args) {
        if (arg === "--dry-run" || arg === "-d") {
            options.dryRun = true;
        } else if (arg === "--verbose" || arg === "-v") {
            options.verbose = true;
        } else if (arg === "--images" || arg === "-i") {
            options.type = "image";
        } else if (arg === "--videos" || arg === "-v") {
            options.type = "video";
        }
    }

    return options;
}

module.exports = {
    runValidation,
    parseArgs,
    getDeletedFilesLogPath,
    isFFmpegAvailable
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
