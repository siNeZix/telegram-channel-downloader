const fs = require("fs");
const path = require("path");

const IMAGE_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "svg"
]);

const VIDEO_EXTENSIONS = new Set([
    "mp4", "avi", "mkv", "mov", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp"
]);

const SUPPORTED_EXTENSIONS = new Set([
    ...IMAGE_EXTENSIONS,
    ...VIDEO_EXTENSIONS
]);

const IGNORED_DIRS = new Set(["node_modules", ".git", "snapshots"]);
const IGNORED_EXTENSIONS = new Set(["json", "txt", "html", "css", "js"]);

/**
 * Recursively scan directory for media files
 * @param {string} dirPath - Directory to scan
 * @param {string} basePath - Base export path for relative paths
 * @returns {Array<{path: string, relativePath: string, extension: string, size: number}>}
 */
function scanDirectory(dirPath, basePath = dirPath) {
    const results = [];

    if (!fs.existsSync(dirPath)) {
        return results;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
                continue;
            }
            results.push(...scanDirectory(fullPath, basePath));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase().replace(".", "");

            if (IGNORED_EXTENSIONS.has(ext)) {
                continue;
            }

            if (!SUPPORTED_EXTENSIONS.has(ext)) {
                continue;
            }

            try {
                const stats = fs.statSync(fullPath);
                const relativePath = path.relative(basePath, fullPath);

                results.push({
                    path: fullPath,
                    relativePath: relativePath,
                    extension: ext,
                    size: stats.size,
                    type: IMAGE_EXTENSIONS.has(ext) ? "image" : "video"
                });
            } catch (err) {
                // Skip files we can't stat
            }
        }
    }

    return results;
}

/**
 * Scan export directory for all media files
 * @param {string} exportPath - Path to export directory
 * @returns {Array<{path: string, relativePath: string, extension: string, size: number}>}
 */
function scanExportDirectory(exportPath) {
    const results = [];

    if (!fs.existsSync(exportPath)) {
        return results;
    }

    const entries = fs.readdirSync(exportPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(exportPath, entry.name);

        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name.toLowerCase())) {
                continue;
            }
            // Scan channel subdirectory
            results.push(...scanDirectory(fullPath, exportPath));
        } else if (entry.isFile()) {
            // Check root-level media files (unlikely but possible)
            const ext = path.extname(entry.name).toLowerCase().replace(".", "");
            if (SUPPORTED_EXTENSIONS.has(ext)) {
                try {
                    const stats = fs.statSync(fullPath);
                    results.push({
                        path: fullPath,
                        relativePath: entry.name,
                        extension: ext,
                        size: stats.size,
                        type: IMAGE_EXTENSIONS.has(ext) ? "image" : "video"
                    });
                } catch (err) {
                    // Skip
                }
            }
        }
    }

    return results;
}

/**
 * Get list of image extensions
 * @returns {string[]}
 */
function getImageExtensions() {
    return Array.from(IMAGE_EXTENSIONS);
}

/**
 * Get list of video extensions
 * @returns {string[]}
 */
function getVideoExtensions() {
    return Array.from(VIDEO_EXTENSIONS);
}

/**
 * Get list of all supported extensions
 * @returns {string[]}
 */
function getSupportedExtensions() {
    return Array.from(SUPPORTED_EXTENSIONS);
}

/**
 * Filter files by type
 * @param {Array} files - Array of file objects
 * @param {string} type - 'image', 'video', or 'all'
 * @returns {Array}
 */
function filterByType(files, type) {
    if (type === "all") {
        return files;
    }
    return files.filter(f => f.type === type);
}

module.exports = {
    scanExportDirectory,
    scanDirectory,
    getImageExtensions,
    getVideoExtensions,
    getSupportedExtensions,
    filterByType,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    IGNORED_DIRS
};
