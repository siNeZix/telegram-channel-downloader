const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const VALIDATION_TIMEOUT = 30000; // 30 seconds

let ffmpegPath = null;
let ffprobePath = null;

/** 
 * Simple logger that avoids circular dependency with helper.js 
 * Only uses console.log for critical errors
 */
const log = {
    debug: (msg) => {
        // Check if debug flag is set
        if (process.argv.includes("--debug")) {
            console.log(`[VALID] ${msg}`);
        }
    },
    error: (msg) => console.error(`[VALID ERROR] ${msg}`)
};

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
 * Find ffmpeg and ffprobe in system PATH
 * @returns {Promise<{ffmpeg: string, ffprobe: string}|null>}
 */
async function findFFmpeg() {
    if (ffmpegPath && ffprobePath) {
        log.debug(`findFFmpeg: using cached paths ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
        return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
    }

    return new Promise((resolve) => {
        // Try to find ffmpeg
        const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
        log.debug(`findFFmpeg: searching with command: ${cmd}`);

        exec(cmd, (error, stdout) => {
            if (error || !stdout.trim()) {
                log.debug(`findFFmpeg: ffmpeg not found, error=${error?.message || 'no stdout'}`);
                resolve(null);
                return;
            }

            const ffmpegBin = stdout.trim().split("\n")[0];
            log.debug(`findFFmpeg: found ffmpeg at ${ffmpegBin}`);
            
            const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
            log.debug(`findFFmpeg: checking ffprobe at ${ffprobeBin}`);

            // Verify ffprobe exists
            if (fs.existsSync(ffprobeBin)) {
                ffmpegPath = ffmpegBin;
                ffprobePath = ffprobeBin;
                log.debug(`findFFmpeg: success, ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
                resolve({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });
            } else {
                log.debug(`findFFmpeg: ffprobe not at expected path, trying alternative`);
                // On Windows, try without .exe extension
                const altFfprobe = ffmpegBin.replace(/ffmpeg\.exe$/, "ffprobe.exe");
                if (fs.existsSync(altFfprobe)) {
                    ffmpegPath = ffmpegBin;
                    ffprobePath = altFfprobe;
                    log.debug(`findFFmpeg: success with alt ffprobe, ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath}`);
                    resolve({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });
                } else {
                    log.debug(`findFFmpeg: ffprobe not found at ${altFfprobe}`);
                    resolve(null);
                }
            }
        });
    });
}

/**
 * Execute a command with timeout and force kill on timeout
 * @param {string} cmd - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean}>}
 */
function execPromise(cmd, timeout = VALIDATION_TIMEOUT) {
    log.debug(`execPromise: executing command, timeout=${timeout}ms`);
    
    return new Promise((resolve) => {
        const startTime = Date.now();
        const proc = exec(cmd, { timeout }, (error, stdout, stderr) => {
            const elapsed = Date.now() - startTime;
            const exitCode = error && error.code !== "SIGTERM" && error.code !== "SIGKILL" ? error.code : 0;
            
            log.debug(`execPromise: completed in ${elapsed}ms, exitCode=${exitCode}, stdout.length=${stdout?.length || 0}, stderr.length=${stderr?.length || 0}`);
            
            resolve({
                stdout: stdout || "",
                stderr: stderr || "",
                exitCode: exitCode,
                timedOut: false
            });
        });

        proc.on("error", (err) => {
            log.error(`execPromise: process error: ${err.message}`);
            resolve({ stdout: "", stderr: "Process error", exitCode: 1, timedOut: false });
        });

        // Handle timeout - force kill the process
        proc.on("timeout", () => {
            log.error(`execPromise: timeout after ${timeout}ms`);
            // Force kill the process tree on Windows
            if (process.platform === "win32" && proc.pid) {
                try {
                    exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
                } catch (e) {
                    // Ignore errors from taskkill
                }
            } else {
                // On Unix, send SIGKILL
                proc.kill("SIGKILL");
            }
            resolve({ stdout: "", stderr: "Validation timed out", exitCode: 1, timedOut: true });
        });
    });
}

/**
 * Validate an image file using ffmpeg
 * @param {string} filePath - Path to image file
 * @param {string} ffmpegBin - Path to ffmpeg binary
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateImage(filePath, ffmpegBin) {
    log.debug(`validateImage: file=${filePath}, ffmpeg=${ffmpegBin}`);
    
    // ffmpeg -v error -i input.jpg -f null -
    // Exit code 0 means valid, non-zero means error
    const escapedPath = escapePathForCmd(filePath);
    const escapedFfmpeg = escapePathForCmd(ffmpegBin);
    const cmd = `${escapedFfmpeg} -v error -i ${escapedPath} -f null -`;
    
    log.debug(`validateImage: running command: ${cmd}`);

    const result = await execPromise(cmd, VALIDATION_TIMEOUT);

    if (result.exitCode === 0) {
        log.debug(`validateImage: valid, file=${path.basename(filePath)}`);
        return { valid: true, error: null };
    }

    // Check if error is about format not found (corrupt file)
    const errorMsg = result.stderr || result.stdout || "Unknown error";
    log.debug(`validateImage: invalid, file=${path.basename(filePath)}, error=${errorMsg.substring(0, 100)}`);
    return { valid: false, error: `ffmpeg: ${errorMsg.substring(0, 100)}` };
}

/**
 * Validate a video file using ffprobe (fast check)
 * @param {string} filePath - Path to video file
 * @param {string} ffprobeBin - Path to ffprobe binary
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateVideo(filePath, ffprobeBin) {
    log.debug(`validateVideo: file=${filePath}, ffprobe=${ffprobeBin}`);
    
    // ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
    // Exit code 0 with duration output means valid
    const escapedPath = escapePathForCmd(filePath);
    const escapedFfprobe = escapePathForCmd(ffprobeBin);
    const cmd = `${escapedFfprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${escapedPath}`;
    
    log.debug(`validateVideo: running command: ${cmd}`);

    const result = await execPromise(cmd, VALIDATION_TIMEOUT);

    if (result.exitCode !== 0) {
        log.debug(`validateVideo: invalid (exit code), file=${path.basename(filePath)}, exitCode=${result.exitCode}`);
        return { valid: false, error: `ffprobe exit code ${result.exitCode}` };
    }

    const output = result.stdout.trim();
    log.debug(`validateVideo: output="${output}"`);

    // If we got a duration number, file is valid
    if (output && !isNaN(parseFloat(output))) {
        log.debug(`validateVideo: valid, file=${path.basename(filePath)}, duration=${output}`);
        return { valid: true, error: null };
    }

    log.debug(`validateVideo: invalid (no duration), file=${path.basename(filePath)}, output="${output.substring(0, 50)}"`);
    return { valid: false, error: `ffprobe: no duration found (${output.substring(0, 50)})` };
}

/**
 * Validate a video file using ffmpeg with deep decode (full check)
 * @param {string} filePath - Path to video file
 * @param {string} ffmpegBin - Path to ffmpeg binary
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateVideoDeep(filePath, ffmpegBin) {
    log.debug(`validateVideoDeep: file=${filePath}, ffmpeg=${ffmpegBin}`);
    
    // ffmpeg -v error -i input.mp4 -f null -
    // This decodes the entire video stream and reports any errors
    const escapedPath = escapePathForCmd(filePath);
    const escapedFfmpeg = escapePathForCmd(ffmpegBin);
    const cmd = `${escapedFfmpeg} -v error -i ${escapedPath} -f null -`;
    
    log.debug(`validateVideoDeep: running deep validation command, timeout=${VALIDATION_TIMEOUT * 3}ms`);

    const result = await execPromise(cmd, VALIDATION_TIMEOUT * 3); // Allow more time for deep validation

    if (result.exitCode === 0) {
        log.debug(`validateVideoDeep: valid (deep), file=${path.basename(filePath)}`);
        return { valid: true, error: null };
    }

    const errorMsg = result.stderr || result.stdout || "Unknown decode error";
    log.debug(`validateVideoDeep: invalid (deep), file=${path.basename(filePath)}, error=${errorMsg.substring(0, 100)}`);
    return { valid: false, error: `ffmpeg decode: ${errorMsg.substring(0, 100)}` };
}

/**
 * Validate a single file
 * @param {string} filePath - Path to file
 * @param {string} type - 'image' or 'video'
 * @param {string} ffmpegBin - Path to ffmpeg binary
 * @param {string} ffprobeBin - Path to ffprobe binary
 * @param {boolean} deep - If true, use deep validation (full decode for video)
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateFile(filePath, type, ffmpegBin, ffprobeBin, deep = false) {
    log.debug(`validateFile: path=${filePath}, type=${type}, deep=${deep}`);
    
    // First check if file exists
    if (!fs.existsSync(filePath)) {
        log.debug(`validateFile: file does not exist: ${filePath}`);
        return { valid: false, error: "File does not exist" };
    }

    // Check file size - empty or very small files are likely corrupt
    try {
        const stats = fs.statSync(filePath);
        log.debug(`validateFile: file size=${stats.size} bytes`);
        
        if (stats.size === 0) {
            log.debug(`validateFile: file is empty: ${filePath}`);
            return { valid: false, error: "File is empty" };
        }
    } catch (err) {
        log.error(`validateFile: cannot stat file ${filePath}: ${err.message}`);
        return { valid: false, error: "Cannot stat file" };
    }

    if (type === "image") {
        return validateImage(filePath, ffmpegBin);
    } else {
        // For video, use deep validation if requested
        if (deep) {
            return validateVideoDeep(filePath, ffmpegBin);
        }
        return validateVideo(filePath, ffprobeBin);
    }
}

/**
 * Validate multiple files with progress callback using worker pool
 * @param {Array} files - Array of file objects with path and type
 * @param {Object} ffmpegPaths - {ffmpeg, ffprobe}
 * @param {Function} progressCallback - Called with (file, result)
 * @param {number} maxParallel - Max parallel validations (default 10)
 * @param {boolean} deep - Use deep validation (full decode for video)
 * @returns {Promise<{valid: number, invalid: number, errors: Array}>}
 */
async function validateFiles(files, ffmpegPaths, progressCallback, maxParallel = 10, deep = false) {
    log.debug(`validateFiles: count=${files.length}, maxParallel=${maxParallel}, deep=${deep}`);
    
    let valid = 0;
    let invalid = 0;
    const errors = [];

    let fileIndex = 0;

    /**
     * Worker function that processes files from the queue
     */
    async function worker() {
        while (fileIndex < files.length) {
            // Get next file index atomically
            const currentIndex = fileIndex++;
            
            // Check if we still have files to process
            if (currentIndex >= files.length) {
                break;
            }

            const file = files[currentIndex];
            log.debug(`validateFiles: processing file ${currentIndex + 1}/${files.length}: ${file.path}`);
            
            const result = await validateFile(file.path, file.type, ffmpegPaths.ffmpeg, ffmpegPaths.ffprobe, deep);

            if (progressCallback) {
                progressCallback(file, result);
            }

            if (result.valid) {
                valid++;
            } else {
                invalid++;
                errors.push({
                    path: file.relativePath || file.path,
                    error: result.error,
                    size: file.size
                });
            }
        }
    }

    // Start maxParallel workers
    log.debug(`validateFiles: starting ${Math.min(maxParallel, files.length)} workers`);
    const workers = [];
    for (let i = 0; i < Math.min(maxParallel, files.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    
    log.debug(`validateFiles: complete, valid=${valid}, invalid=${invalid}, errors=${errors.length}`);

    return { valid, invalid, errors };
}

/**
 * Check if ffmpeg is available
 * @returns {Promise<boolean>}
 */
async function isFFmpegAvailable() {
    const result = await findFFmpeg();
    log.debug(`isFFmpegAvailable: ${result !== null}`);
    return result !== null;
}

/**
 * Get ffmpeg paths
 * @returns {Promise<{ffmpeg: string, ffprobe: string}|null>}
 */
async function getFFmpegPaths() {
    return findFFmpeg();
}

module.exports = {
    findFFmpeg,
    isFFmpegAvailable,
    getFFmpegPaths,
    validateFile,
    validateFiles,
    validateImage,
    validateVideo,
    validateVideoDeep,
    escapePathForCmd
};
