const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const VALIDATION_TIMEOUT = 30000; // 30 seconds

let ffmpegPath = null;
let ffprobePath = null;

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
        return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
    }

    return new Promise((resolve) => {
        // Try to find ffmpeg
        const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";

        exec(cmd, (error, stdout) => {
            if (error || !stdout.trim()) {
                resolve(null);
                return;
            }

            const ffmpegBin = stdout.trim().split("\n")[0];
            const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");

            // Verify ffprobe exists
            if (fs.existsSync(ffprobeBin)) {
                ffmpegPath = ffmpegBin;
                ffprobePath = ffprobeBin;
                resolve({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });
            } else {
                // On Windows, try without .exe extension
                const altFfprobe = ffmpegBin.replace(/ffmpeg\.exe$/, "ffprobe.exe");
                if (fs.existsSync(altFfprobe)) {
                    ffmpegPath = ffmpegBin;
                    ffprobePath = altFfprobe;
                    resolve({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });
                } else {
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
    return new Promise((resolve) => {
        const proc = exec(cmd, { timeout }, (error, stdout, stderr) => {
            resolve({
                stdout: stdout || "",
                stderr: stderr || "",
                exitCode: error && error.code !== "SIGTERM" && error.code !== "SIGKILL" ? error.code : 0,
                timedOut: false
            });
        });

        proc.on("error", () => {
            resolve({ stdout: "", stderr: "Process error", exitCode: 1, timedOut: false });
        });

        // Handle timeout - force kill the process
        proc.on("timeout", () => {
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
    // ffmpeg -v error -i input.jpg -f null -
    // Exit code 0 means valid, non-zero means error
    const escapedPath = escapePathForCmd(filePath);
    const escapedFfmpeg = escapePathForCmd(ffmpegBin);
    const cmd = `${escapedFfmpeg} -v error -i ${escapedPath} -f null -`;

    const result = await execPromise(cmd, VALIDATION_TIMEOUT);

    if (result.exitCode === 0) {
        return { valid: true, error: null };
    }

    // Check if error is about format not found (corrupt file)
    const errorMsg = result.stderr || result.stdout || "Unknown error";
    return { valid: false, error: `ffmpeg: ${errorMsg.substring(0, 100)}` };
}

/**
 * Validate a video file using ffprobe
 * @param {string} filePath - Path to video file
 * @param {string} ffprobeBin - Path to ffprobe binary
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateVideo(filePath, ffprobeBin) {
    // ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
    // Exit code 0 with duration output means valid
    const escapedPath = escapePathForCmd(filePath);
    const escapedFfprobe = escapePathForCmd(ffprobeBin);
    const cmd = `${escapedFfprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${escapedPath}`;

    const result = await execPromise(cmd, VALIDATION_TIMEOUT);

    if (result.exitCode !== 0) {
        return { valid: false, error: `ffprobe exit code ${result.exitCode}` };
    }

    const output = result.stdout.trim();

    // If we got a duration number, file is valid
    if (output && !isNaN(parseFloat(output))) {
        return { valid: true, error: null };
    }

    return { valid: false, error: `ffprobe: no duration found (${output.substring(0, 50)})` };
}

/**
 * Validate a single file
 * @param {string} filePath - Path to file
 * @param {string} type - 'image' or 'video'
 * @param {string} ffmpegBin - Path to ffmpeg binary
 * @param {string} ffprobeBin - Path to ffprobe binary
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateFile(filePath, type, ffmpegBin, ffprobeBin) {
    // First check if file exists
    if (!fs.existsSync(filePath)) {
        return { valid: false, error: "File does not exist" };
    }

    // Check file size - empty or very small files are likely corrupt
    try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            return { valid: false, error: "File is empty" };
        }
    } catch (err) {
        return { valid: false, error: "Cannot stat file" };
    }

    if (type === "image") {
        return validateImage(filePath, ffmpegBin);
    } else {
        return validateVideo(filePath, ffprobeBin);
    }
}

/**
 * Validate multiple files with progress callback using worker pool
 * @param {Array} files - Array of file objects with path and type
 * @param {Object} ffmpegPaths - {ffmpeg, ffprobe}
 * @param {Function} progressCallback - Called with (file, result)
 * @param {number} maxParallel - Max parallel validations (default 10)
 * @returns {Promise<{valid: number, invalid: number, errors: Array}>}
 */
async function validateFiles(files, ffmpegPaths, progressCallback, maxParallel = 10) {
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
            const result = await validateFile(file.path, file.type, ffmpegPaths.ffmpeg, ffmpegPaths.ffprobe);

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
    const workers = [];
    for (let i = 0; i < Math.min(maxParallel, files.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    return { valid, invalid, errors };
}

/**
 * Check if ffmpeg is available
 * @returns {Promise<boolean>}
 */
async function isFFmpegAvailable() {
    const result = await findFFmpeg();
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
    escapePathForCmd
};
