const fs = require("fs");
const path = require("path");
const { scanExportDirectory } = require("./file_scanner");
const { isFFmpegAvailable, getFFmpegPaths, validateFiles, validateFile, validateVideoDeep } = require("./ffmpeg_validator");
const { loadSnapshots, logMessage } = require("../utils/helper");
const paths = require("../utils/paths");
const db = require("../utils/db");

const MAX_PARALLEL = 10;

const consoleColors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    reset: "\x1b[0m"
};

const log = {
    info: (msg) => {
        console.log(`📢: ${consoleColors.cyan} ${msg} ${consoleColors.reset}`);
        logMessage.valid(`[VALID] ${msg}`);
    },
    success: (msg) => {
        console.log(`✅ ${consoleColors.green} ${msg} ${consoleColors.reset}`);
        logMessage.valid(`[VALID] ${msg}`);
    },
    error: (msg) => {
        console.log(`❌ ${consoleColors.red} ${msg} ${consoleColors.reset}`);
        logMessage.error(`[VALID] ${msg}`);
    },
    warn: (msg) => {
        console.log(`⚠️ ${consoleColors.yellow} ${msg} ${consoleColors.reset}`);
        logMessage.warn(`[VALID] ${msg}`);
    },
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

/**
 * Delete a file
 * @param {string} filePath
 * @returns {boolean}
 */
function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        logMessage.valid(`[VALID] Deleted file: ${filePath}`);
        return true;
    } catch (err) {
        logMessage.error(`[VALID] Failed to delete ${filePath}: ${err.message}`);
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
        ignoreSnapshots = false,
        cache = false
    } = options;

    logMessage.valid(`=== Starting file validation: dryRun=${dryRun}, verbose=${verbose}, type=${type}, deep=${deep}, cache=${cache}, exportPath=${exportPath} ===`);
    
    const startTime = Date.now();
    let totalScanned = 0;
    let totalValid = 0;
    let totalInvalid = 0;
    let totalDeleted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalDbConfirmed = 0;
    let totalDbMissing = 0;
    let totalDbRecovered = 0;
    let deletedEntries = [];
    let errorEntries = [];

    log.info(`Starting file validation...`);
    if (dryRun) {
        log.warn(`DRY-RUN MODE: No files will be deleted`);
    }
    if (cache) {
        log.info(`CACHE MODE: Checking files against database...`);
        if (deep) {
            log.info(`DEEP VALIDATION: Will attempt to recover missing files`);
        }
    }

    // Load snapshots for all channels if not ignored
    const snapshotsByChannel = new Map();
    if (!ignoreSnapshots) {
        log.info(`Loading snapshots to skip pre-validated files...`);
        logMessage.valid(`[VALID] Loading snapshots from export directory: ${exportPath}`);
        
        const entries = fs.readdirSync(exportPath, { withFileTypes: true });
        let totalSnapshotEntries = 0;
        
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== "snapshots") {
                const channelPath = path.join(exportPath, entry.name);
                const snapshots = loadSnapshots(channelPath);
                if (snapshots.size > 0) {
                    snapshotsByChannel.set(channelPath, snapshots);
                    totalSnapshotEntries += snapshots.size;
                    log.info(`Loaded ${snapshots.size} snapshot entries for '${entry.name}'`);
                }
            }
        }
        logMessage.valid(`[VALID] Loaded ${totalSnapshotEntries} total snapshot entries across ${snapshotsByChannel.size} channels`);
    } else {
        logMessage.valid(`[VALID] Ignoring snapshots (ignoreSnapshots=true)`);
    }

    // Check ffmpeg availability
    log.info(`Checking ffmpeg availability...`);
    logMessage.valid(`[VALID] Checking ffmpeg availability`);
    
    const ffmpegAvailable = await isFFmpegAvailable();
    if (!ffmpegAvailable) {
        log.error(`ffmpeg/ffprobe not found in PATH. Please install ffmpeg first.`);
        logMessage.error(`[VALID] ffmpeg not found`);
        process.exit(1);
    }

    const ffmpegPaths = await getFFmpegPaths();
    log.success(`Found ffmpeg: ${ffmpegPaths.ffmpeg}`);
    log.success(`Found ffprobe: ${ffmpegPaths.ffprobe}`);
    logMessage.valid(`[VALID] ffmpeg: ${ffmpegPaths.ffmpeg}, ffprobe: ${ffmpegPaths.ffprobe}`);

    // Check export directory
    if (!fs.existsSync(exportPath)) {
        log.error(`Export directory not found: ${exportPath}`);
        logMessage.error(`[VALID] Export directory not found: ${exportPath}`);
        process.exit(1);
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
        files = files.filter(f => f.type === type);
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
                logMessage.warn(`[CACHE] Cannot extract IDs from path: ${file.relativePath}, channelId=${channelId}, msgId=${messageId}`);
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
                
                if (deep && fs.existsSync(file.path)) {
                    // DEEP mode: try to validate with FFmpeg
                    logMessage.info(`[CACHE] Running deep validation for: ${file.relativePath}`);
                    
                    const validationResult = await validateFile(
                        file.path,
                        file.type,
                        ffmpegPaths.ffmpeg,
                        ffmpegPaths.ffprobe,
                        true // deep validation
                    );
                    
                    if (validationResult.valid) {
                        // File is actually valid! Recover it by updating DB
                        logMessage.success(`[CACHE] File is valid, recovering: ${file.relativePath}`);
                        db.setFileDownloaded(channelId, outputFolder, messageId, 1);
                        totalDbRecovered++;
                    } else {
                        // File is corrupt - delete it
                        logMessage.warn(`[CACHE] File failed validation, deleting: ${file.relativePath}`);
                        if (dryRun) {
                            log.dryrun(`Would delete (not in DB, invalid): ${file.relativePath}`);
                        } else {
                            const deleted = deleteFile(file.path);
                            if (deleted) {
                                totalDeleted++;
                                deletedEntries.push({
                                    path: file.relativePath,
                                    size: file.size,
                                    reason: "not in DB + deep validation failed",
                                    timestamp: new Date().toISOString()
                                });
                                log.deleted(`${file.relativePath} (not in DB, invalid)`);
                            }
                        }
                    }
                } else {
                    // Not in deep mode or file doesn't exist - delete if exists
                    if (fs.existsSync(file.path)) {
                        logMessage.warn(`[CACHE] File not in DB, deleting: ${file.relativePath}`);
                        if (dryRun) {
                            log.dryrun(`Would delete (not in DB): ${file.relativePath}`);
                        } else {
                            const deleted = deleteFile(file.path);
                            if (deleted) {
                                totalDeleted++;
                                deletedEntries.push({
                                    path: file.relativePath,
                                    size: file.size,
                                    reason: "not marked as downloaded in DB",
                                    timestamp: new Date().toISOString()
                                });
                                log.deleted(`${file.relativePath} (not in DB)`);
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
        
        // Print cache summary
        console.log("\n" + "=".repeat(50));
        log.info(`=== Cache Validation Complete ===`);
        console.log("=".repeat(50));
        log.info(`Scanned:       ${totalScanned} files`);
        if (totalSkipped > 0) {
            log.warn(`Skipped:       ${totalSkipped} files (from snapshots)`);
        }
        log.success(`DB Confirmed:  ${totalDbConfirmed} files`);
        log.info(`DB Missing:     ${totalDbMissing} files`);
        if (deep) {
            log.info(`DB Recovered:   ${totalDbRecovered} files (validated and updated)`);
        }
        log.error(`Deleted:       ${totalDeleted} files`);
        if (dryRun) {
            log.warn(`DRY-RUN: No files were actually deleted`);
        }
        log.info(`Duration:      ${formatDuration((Date.now() - startTime) / 1000)}`);
        console.log("=".repeat(50));
        
        logMessage.valid(`=== Cache summary: total=${totalScanned}, skipped=${totalSkipped}, dbConfirmed=${totalDbConfirmed}, dbMissing=${totalDbMissing}, dbRecovered=${totalDbRecovered}, deleted=${totalDeleted} ===`);
        
        return {
            totalScanned,
            totalValid: totalDbConfirmed,
            totalInvalid: totalDbMissing,
            totalDeleted,
            totalSkipped,
            totalDbConfirmed,
            totalDbMissing,
            totalDbRecovered,
            errors: totalErrors
        };
    }
    
    // NORMAL MODE: Run standard validation
    log.info(`Validating files (max ${MAX_PARALLEL} parallel)...`);
    logMessage.valid(`[VALID] Starting validation: count=${files.length}, maxParallel=${MAX_PARALLEL}, deep=${deep}`);

    let lastProgressUpdate = Date.now();
    const PROGRESS_UPDATE_INTERVAL = 500;
    const validationStart = Date.now();
    let validationCount = 0;
    let validationErrors = 0;

    const progressCallback = (file, result) => {
        const now = Date.now();
        validationCount++;

        // Check if this file is in any snapshot (skip validation if so)
        if (snapshotsByChannel.size > 0) {
            // Find which channel this file belongs to
            for (const [channelPath, snapshots] of snapshotsByChannel) {
                // Check if file path starts with channel path
                if (file.path.startsWith(channelPath)) {
                    // Extract path relative to channel folder (remove "channel_name/" prefix)
                    const channelName = path.basename(channelPath);
                    const relativeToChannel = file.relativePath.substring(channelName.length + 1);
                    
                    if (snapshots.has(relativeToChannel)) {
                        // File is in snapshot - skip validation
                        totalSkipped++;
                        logMessage.cache(`[VALID] Skipped (snapshot): ${file.relativePath}`);
                        if (verbose) {
                            log.info(`Skipped (snapshot): ${file.relativePath}`);
                        }
                        return; // Don't count as valid or invalid, just skip
                    }
                    break;
                }
            }
        }

        if (verbose || now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
            printProgress(totalValid + totalInvalid + validationErrors, files.length);
            lastProgressUpdate = now;
        }

        if (!result.valid) {
            totalInvalid++;
            validationErrors++;
            errorEntries.push({
                path: file.relativePath,
                size: file.size,
                error: result.error,
                timestamp: new Date().toISOString()
            });
            
            logMessage.warn(`[VALID] File invalid: ${file.relativePath}, size=${formatBytes(file.size)}, error=${result.error}`);

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
            logMessage.valid(`[VALID] File valid: ${file.relativePath}`);
        }
    };

    const validationResult = await validateFiles(files, ffmpegPaths, progressCallback, MAX_PARALLEL, deep);
    const validationTime = Date.now() - validationStart;
    
    logMessage.valid(`[VALID] Validation complete: validated=${validationCount}, valid=${totalValid}, invalid=${totalInvalid}, errors=${validationErrors}, time=${validationTime}ms`);

    // Clear progress line
    process.stdout.write("\r" + " ".repeat(80) + "\r");

    // Print summary
    console.log("\n" + "=".repeat(50));
    log.info(`=== Validation Complete ===`);
    console.log("=".repeat(50));
    log.info(`Scanned:  ${totalScanned} files`);
    if (totalSkipped > 0) {
        log.warn(`Skipped:  ${totalSkipped} files (from snapshots)`);
    }
    log.success(`Valid:   ${totalValid} files`);
    log.error(`Invalid: ${totalInvalid} files`);
    if (dryRun) {
        log.warn(`Would delete: ${totalInvalid} files`);
    } else {
        log.info(`Deleted: ${totalDeleted} files`);
    }
    log.info(`Errors:  ${validationErrors}`);
    log.info(`Duration: ${formatDuration((Date.now() - startTime) / 1000)}`);
    console.log("=".repeat(50));

    logMessage.valid(`=== Validation summary: total=${totalScanned}, valid=${totalValid}, invalid=${totalInvalid}, skipped=${totalSkipped}, deleted=${totalDeleted}, errors=${validationErrors}, duration=${formatDuration((Date.now() - startTime) / 1000)} ===`);

    return {
        totalScanned,
        totalValid,
        totalInvalid,
        totalDeleted,
        totalSkipped,
        errors: validationErrors
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
        ignoreSnapshots: false,
        cache: false
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
        } else if (arg === "--deep" || arg === "-D") {
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
