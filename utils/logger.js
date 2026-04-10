const fs = require('fs');
const path = require('path');
const pathsManager = require('./paths');

let debugStream = null;
let normalStream = null;
let initialized = false;

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const MAX_ARCHIVE_FILES = 50;
const DEBUG_LOG_NAME = 'debug.log';
const CURRENT_LOG_NAME = 'current.log';
const DEBUG_ARCHIVE_PREFIX = 'debug-';
const ARCHIVE_LOG_REGEX = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/;
const DEBUG_ARCHIVE_LOG_REGEX = /^debug-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/;
const MAX_DEBUG_LOG_SIZE_BYTES = 10 * 1024 * 1024;

let lastLogTimestamp = null;

function stripAnsi(str) {
    return str.replace(ANSI_REGEX, '');
}

function formatDateForFilename(date) {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d}-${h}-${mi}-${s}`;
}

function cleanupOldArchives() {
    const logsDir = pathsManager.logs;

    if (!fs.existsSync(logsDir)) return;

    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => ARCHIVE_LOG_REGEX.test(f))
            .map(f => {
                const filePath = path.join(logsDir, f);
                const stats = fs.statSync(filePath);
                return { name: f, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length > MAX_ARCHIVE_FILES) {
            const toDelete = files.slice(MAX_ARCHIVE_FILES);
            for (const file of toDelete) {
                const filePath = path.join(logsDir, file.name);
                fs.unlinkSync(filePath);
            }
        }
    } catch (err) {
        reportLoggerFailure(err, 'Failed to clean old current log archives');
    }
}

function reportLoggerFailure(err, context) {
    const message = err?.message || String(err);
    try {
        process.stderr.write(`[LOGGER ERROR] ${context}: ${message}\n`);
    } catch (stderrErr) {
        // Nothing else we can do if stderr is unavailable.
    }
}

function rotateDebugLogIfNeeded(logsDir, debugLogPath) {
    if (!fs.existsSync(debugLogPath)) return;

    try {
        const stats = fs.statSync(debugLogPath);
        if (stats.size < MAX_DEBUG_LOG_SIZE_BYTES) {
            return;
        }

        const archiveName = `${DEBUG_ARCHIVE_PREFIX}${formatDateForFilename(new Date())}.log`;
        const archivePath = path.join(logsDir, archiveName);
        fs.renameSync(debugLogPath, archivePath);
    } catch (err) {
        reportLoggerFailure(err, 'Failed to rotate debug.log');
    }
}

function cleanupOldDebugArchives() {
    const logsDir = pathsManager.logs;

    if (!fs.existsSync(logsDir)) return;

    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => DEBUG_ARCHIVE_LOG_REGEX.test(f))
            .map(f => {
                const filePath = path.join(logsDir, f);
                const stats = fs.statSync(filePath);
                return { name: f, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length > MAX_ARCHIVE_FILES) {
            const toDelete = files.slice(MAX_ARCHIVE_FILES);
            for (const file of toDelete) {
                fs.unlinkSync(path.join(logsDir, file.name));
            }
        }
    } catch (err) {
        reportLoggerFailure(err, 'Failed to clean old debug log archives');
    }
}

function init() {
    if (initialized && debugStream && normalStream) return;

    const logsDir = pathsManager.logs;

    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const currentLogPath = path.join(logsDir, CURRENT_LOG_NAME);
    if (fs.existsSync(currentLogPath)) {
        const archiveName = formatDateForFilename(new Date()) + '.log';
        const archivePath = path.join(logsDir, archiveName);
        try {
            fs.renameSync(currentLogPath, archivePath);
        } catch (err) {
            try { fs.unlinkSync(currentLogPath); } catch (e) {}
        }
    }

    const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
    rotateDebugLogIfNeeded(logsDir, debugLogPath);
    if (!fs.existsSync(debugLogPath)) {
        fs.writeFileSync(debugLogPath, '');
    }

    cleanupOldArchives();
    cleanupOldDebugArchives();

    debugStream = fs.createWriteStream(debugLogPath, { flags: 'a', encoding: 'utf8' });
    normalStream = fs.createWriteStream(currentLogPath, { flags: 'a', encoding: 'utf8' });

    debugStream.on('error', (err) => reportLoggerFailure(err, 'debug stream error'));
    normalStream.on('error', (err) => reportLoggerFailure(err, 'current stream error'));

    initialized = true;
}

function write(level, message) {
    if (!initialized || !debugStream || !normalStream) {
        init();
    }

    const cleanMessage = stripAnsi(message);
    const now = new Date();
    const timestamp = now.toISOString();

    let deltaStr = '';
    if (lastLogTimestamp !== null) {
        const deltaMs = now - lastLogTimestamp;
        if (deltaMs >= 1000) {
            deltaStr = ` (+${(deltaMs / 1000).toFixed(2)}s)`;
        } else {
            deltaStr = ` (+${deltaMs}ms)`;
        }
    }
    lastLogTimestamp = now;

    const fileLine = `[${timestamp}] [${level.toUpperCase()}]${deltaStr} ${cleanMessage}\n`;

    try { debugStream.write(fileLine); } catch (e) { reportLoggerFailure(e, 'Failed writing to debug log'); }

    const normalLevels = ['info', 'success', 'warn', 'error'];
    if (normalLevels.includes(level)) {
        try { normalStream.write(fileLine); } catch (e) { reportLoggerFailure(e, 'Failed writing to current log'); }
    }
}

function writeSync(level, message) {
    const logsDir = pathsManager.logs;
    const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
    const currentLogPath = path.join(logsDir, CURRENT_LOG_NAME);
    const cleanMessage = stripAnsi(message);
    const timestamp = new Date().toISOString();
    const fileLine = `[${timestamp}] [${level.toUpperCase()}] ${cleanMessage}\n`;

    try {
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
    } catch (e) { reportLoggerFailure(e, 'Failed to create logs directory for sync write'); }

    try {
        fs.appendFileSync(debugLogPath, fileLine);
    } catch (e) { reportLoggerFailure(e, 'Failed sync write to debug log'); }

    const normalLevels = ['info', 'success', 'warn', 'error'];
    if (normalLevels.includes(level)) {
        try {
            fs.appendFileSync(currentLogPath, fileLine);
        } catch (e) { reportLoggerFailure(e, 'Failed sync write to current log'); }
    }
}

function close() {
    if (debugStream) {
        try { debugStream.end(); } catch (e) { reportLoggerFailure(e, 'Failed to close debug stream'); }
        debugStream = null;
    }
    if (normalStream) {
        try { normalStream.end(); } catch (e) { reportLoggerFailure(e, 'Failed to close current stream'); }
        normalStream = null;
    }
    initialized = false;
}

function flush() {
    if (debugStream) {
        try { debugStream.write(''); } catch (e) { reportLoggerFailure(e, 'Failed to flush debug stream'); }
    }
    if (normalStream) {
        try { normalStream.write(''); } catch (e) { reportLoggerFailure(e, 'Failed to flush current stream'); }
    }
}

process.on('uncaughtException', (err) => {
    const msg = `[FATAL] Uncaught exception: ${err?.message || String(err)}\n${err?.stack || ''}`;
    writeSync('error', msg);
    console.error(msg);
    close();
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = `[FATAL] Unhandled rejection: ${reason?.message || String(reason)}\n${reason?.stack || ''}`;
    writeSync('error', msg);
    console.error(msg);
});

module.exports = {
    init,
    write,
    writeSync,
    close,
    flush,
    stripAnsi,
};
