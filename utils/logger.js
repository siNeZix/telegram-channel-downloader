const fs = require("fs");
const path = require("path");
const pathsManager = require("./paths");

let debugStream = null;
let normalStream = null;
let initialized = false;
let consolePatched = false;
let flushInterval = null;
let writePending = [];
let drainInProgress = false;
const FLUSH_INTERVAL_MS = 5000;
const MAX_PENDING_WRITES = 5000;

const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

const ANSI_REGEX = new RegExp(String.fromCharCode(0x1b) + "\\[[0-9;]*m", "g");
const MAX_ARCHIVE_FILES = 50;
const MAX_MESSAGE_SIZE_BYTES = 100 * 1024;
const MAX_DEBUG_LOG_SIZE_BYTES = 1 * 1024 * 1024;
const MAX_DEBUG_ARCHIVES_TOTAL_SIZE = 5 * 1024 * 1024;
const MAX_MESSAGE_SIZE_BYTES = 50 * 1024;

let lastLogTimestamp = null;
let initInProgress = false;
let lastRotationCheckSize = 0;

const DEBUG_RATE_LIMIT_PER_SECOND = 3;
const DEBUG_CIRCUIT_BREAKER_MS = 10000;
let debugRateWindowStart = 0;
let debugRateWindowCount = 0;
let debugSuppressedCount = 0;
let debugCircuitBreakerUntil = 0;

function formatConsoleTimestamp(date) {
	const h = String(date.getHours()).padStart(2, "0");
	const mi = String(date.getMinutes()).padStart(2, "0");
	const s = String(date.getSeconds()).padStart(2, "0");
	const ms = String(date.getMilliseconds()).padStart(3, "0");
	return `[${h}:${mi}:${s}.${ms}]`;
}

function prefixConsoleArgs(args) {
	const prefix = formatConsoleTimestamp(new Date());

	if (args.length === 0) {
		return [prefix];
	}

	if (typeof args[0] !== "string") {
		return [prefix, ...args];
	}

	const firstArg = args[0];
	const match = firstArg.match(/^([\r\n]+)(.*)$/s);

	if (!match) {
		return [`${prefix} ${firstArg}`, ...args.slice(1)];
	}

	const [, leadingWhitespace, rest] = match;
	return [`${leadingWhitespace}${prefix} ${rest}`, ...args.slice(1)];
}

function installConsoleTimestamps() {
	if (consolePatched) {
		return;
	}

	for (const method of Object.keys(originalConsole)) {
		console[method] = (...args) => originalConsole[method](...prefixConsoleArgs(args));
	}

	consolePatched = true;
}

function stripAnsi(str) {
	return str.replace(ANSI_REGEX, "");
}

function truncateMessageIfTooLarge(message) {
	if (!message) return message;
	const bytes = Buffer.byteLength(message, "utf8");
	if (bytes <= MAX_MESSAGE_SIZE_BYTES) return message;
	const suffix = "\n...truncated (message too large to log)\n";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let truncated = message.slice(0, MAX_MESSAGE_SIZE_BYTES - suffixBytes);
	// trim to valid UTF-8 boundary
	while (Buffer.byteLength(truncated, "utf8") > MAX_MESSAGE_SIZE_BYTES - suffixBytes) {
		truncated = truncated.slice(0, -1);
	}
	return truncated + suffix;
}

function shouldDropDebug() {
	const now = Date.now();
	if (now - debugRateWindowStart > 1000) {
		if (debugSuppressedCount > 0) {
			try {
				const note = `[DEBUG] ${debugSuppressedCount} debug message(s) suppressed by rate limit\n`;
				if (debugStream) {
					debugStream.write(note);
				}
			} catch (e) {
				// ignore
			}
		}
		debugRateWindowStart = now;
		debugRateWindowCount = 0;
		debugSuppressedCount = 0;
	}
	if (debugRateWindowCount >= DEBUG_RATE_LIMIT_PER_SECOND) {
		debugSuppressedCount++;
		return true;
	}
	debugRateWindowCount++;
	return false;
}

function formatDateForFilename(date) {
	const y = date.getFullYear();
	const mo = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const h = String(date.getHours()).padStart(2, "0");
	const mi = String(date.getMinutes()).padStart(2, "0");
	const s = String(date.getSeconds()).padStart(2, "0");
	return `${y}-${mo}-${d}-${h}-${mi}-${s}`;
}

function cleanupOldArchives() {
	const logsDir = pathsManager.logs;

	if (!fs.existsSync(logsDir)) return;

	try {
		const files = fs
			.readdirSync(logsDir)
			.filter((f) => ARCHIVE_LOG_REGEX.test(f))
			.map((f) => {
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
		reportLoggerFailure(err, "Failed to clean old current log archives");
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
		reportLoggerFailure(err, "Failed to rotate debug.log");
	}
}

function rotateDebugLogIfNeededSync(logsDir, debugLogPath) {
	if (!fs.existsSync(debugLogPath)) return;
	try {
		const stats = fs.statSync(debugLogPath);
		if (stats.size < MAX_DEBUG_LOG_SIZE_BYTES) {
			return;
		}
		const archiveName = `${DEBUG_ARCHIVE_PREFIX}${formatDateForFilename(new Date())}.log`;
		const archivePath = path.join(logsDir, archiveName);
		fs.renameSync(debugLogPath, archivePath);
		cleanupOldDebugArchivesBySize();
	} catch (err) {
		reportLoggerFailure(err, "Failed to rotate debug.log in sync mode");
	}
}

function reopenDebugStream() {
	const logsDir = pathsManager.logs;
	const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);

	rotateDebugLogIfNeeded(logsDir, debugLogPath);
	cleanupOldDebugArchives();

	if (!fs.existsSync(debugLogPath)) {
		try {
			fs.writeFileSync(debugLogPath, "");
		} catch (err) {
			reportLoggerFailure(err, "Failed to recreate debug.log after rotation");
			return;
		}
	}

	try {
		const oldStream = debugStream;
		const newStream = fs.createWriteStream(debugLogPath, { flags: "a", encoding: "utf8" });

		newStream.on("error", (err) => {
			reportLoggerFailure(err, "debug stream error");
			if (debugStream === newStream) {
				debugStream = null;
				initialized = false;
			}
		});
		newStream.on("drain", () => drainPendingWrites());

		if (oldStream) {
			writePending = writePending.filter((w) => w.stream !== oldStream);
			try {
				oldStream.end();
			} catch (e) {
				reportLoggerFailure(e, "Failed to end old debug stream during rotation");
			}
		}

		debugStream = newStream;
		lastRotationCheckSize = 0;
	} catch (err) {
		reportLoggerFailure(err, "Failed to reopen debug stream after rotation");
	}
}

function maybeRotateDebugStream(fileLine) {
	const lineBytes = Buffer.byteLength(fileLine, "utf8");
	debugBytesWritten += lineBytes;

	if (debugBytesWritten >= MAX_DEBUG_LOG_SIZE_BYTES - MAX_MESSAGE_SIZE_BYTES) {
		const logsDir = pathsManager.logs;
		const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
		if (fs.existsSync(debugLogPath)) {
			try {
				const stats = fs.statSync(debugLogPath);
				if (stats.size + lineBytes >= MAX_DEBUG_LOG_SIZE_BYTES) {
					reopenDebugStream();
					debugBytesWritten = lineBytes;
				}
			} catch (err) {
				reportLoggerFailure(err, "Failed to check debug log size for rotation");
			}
		}
	}
}

function cleanupOldDebugArchivesBySize() {
	const logsDir = pathsManager.logs;
	if (!fs.existsSync(logsDir)) return;

	try {
		let files = fs
			.readdirSync(logsDir)
			.filter((f) => DEBUG_ARCHIVE_LOG_REGEX.test(f))
			.map((f) => {
				const filePath = path.join(logsDir, f);
				const stats = fs.statSync(filePath);
				return { name: f, mtime: stats.mtime, size: stats.size };
			})
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		let totalSize = files.reduce((sum, f) => sum + f.size, 0);
		while (totalSize > MAX_DEBUG_ARCHIVES_TOTAL_SIZE && files.length > 0) {
			const oldest = files.pop();
			fs.unlinkSync(path.join(logsDir, oldest.name));
			totalSize -= oldest.size;
		}
	} catch (err) {
		reportLoggerFailure(err, "Failed to clean old debug log archives by size");
	}
}

function cleanupOldDebugArchives() {
	cleanupOldDebugArchivesBySize();
}

function init() {
	if (initInProgress) return;
	if (initialized && debugStream && normalStream) return;

	initInProgress = true;

	try {
		installConsoleTimestamps();

		const logsDir = pathsManager.logs;

		if (!fs.existsSync(logsDir)) {
			fs.mkdirSync(logsDir, { recursive: true });
		}

		const currentLogPath = path.join(logsDir, CURRENT_LOG_NAME);
		if (fs.existsSync(currentLogPath)) {
			const archiveName = formatDateForFilename(new Date()) + ".log";
			const archivePath = path.join(logsDir, archiveName);
		try {
			fs.renameSync(currentLogPath, archivePath);
		} catch (err) {
			try {
				fs.unlinkSync(currentLogPath);
			} catch {
				// best effort cleanup
			}
		}
		}

		const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
		rotateDebugLogIfNeeded(logsDir, debugLogPath);
		if (!fs.existsSync(debugLogPath)) {
			fs.writeFileSync(debugLogPath, "");
		}

		cleanupOldArchives();
		cleanupOldDebugArchives();

		debugStream = fs.createWriteStream(debugLogPath, { flags: "a", encoding: "utf8" });
		normalStream = fs.createWriteStream(currentLogPath, { flags: "a", encoding: "utf8" });

		const ds = debugStream;
		const ns = normalStream;
		ds.on("error", (err) => {
			reportLoggerFailure(err, "debug stream error");
			if (debugStream === ds) {
				debugStream = null;
				initialized = false;
			}
		});
		ds.on("drain", () => drainPendingWrites());
		ns.on("error", (err) => {
			reportLoggerFailure(err, "current stream error");
			if (normalStream === ns) {
				normalStream = null;
				initialized = false;
			}
		});
		ns.on("drain", () => drainPendingWrites());

		if (flushInterval) clearInterval(flushInterval);
		flushInterval = setInterval(flush, FLUSH_INTERVAL_MS);
		flushInterval.unref();

		debugBytesWritten = 0;
		initialized = true;
	} catch (err) {
		reportLoggerFailure(err, "Failed to initialize logger");
		debugStream = null;
		normalStream = null;
		initialized = false;
	} finally {
		initInProgress = false;
	}
}

function drainPendingWrites() {
	if (drainInProgress) return;
	drainInProgress = true;

	const drained = [];
	for (const { stream, data } of writePending) {
		const canContinue = stream.write(data);
		if (canContinue) {
			drained.push({ stream, data });
		} else {
			break;
		}
	}
	writePending = writePending.filter((w) => !drained.includes(w));

	drainInProgress = false;
}

function write(level, message) {
	if (typeof level !== "string" || !level) {
		reportLoggerFailure(new Error(`Invalid log level: ${level}`), "write skipped");
		return;
	}
	if (!initialized || !debugStream || !normalStream) {
		init();
	}

	if (!debugStream || !normalStream) {
		reportLoggerFailure(new Error("Logger streams unavailable after init"), "write skipped");
		return;
	}

	const cleanMessage = stripAnsi(truncateMessageIfTooLarge(message));
	const now = new Date();
	const timestamp = now.toISOString();

	let deltaStr = "";
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

	if (level === "debug" && shouldDropDebug()) {
		return;
	}

	maybeRotateDebugStream(fileLine);

	const writeToStream = (stream, data) => {
		const ok = stream.write(data);
		if (!ok && writePending.length < MAX_PENDING_WRITES) {
			writePending.push({ stream, data });
		}
	};

	try {
		writeToStream(debugStream, fileLine);
	} catch (e) {
		reportLoggerFailure(e, "Failed writing to debug log");
	}

	const normalLevels = ["info", "success", "warn", "error"];
	if (normalLevels.includes(level)) {
		try {
			writeToStream(normalStream, fileLine);
		} catch (e) {
			reportLoggerFailure(e, "Failed writing to current log");
		}
	}
}

function writeSync(level, message) {
	const logsDir = pathsManager.logs;
	const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
	const currentLogPath = path.join(logsDir, CURRENT_LOG_NAME);
	const cleanMessage = stripAnsi(truncateMessageIfTooLarge(message));
	const now = new Date();
	const timestamp = now.toISOString();

	let deltaStr = "";
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

	try {
		if (!fs.existsSync(logsDir)) {
			fs.mkdirSync(logsDir, { recursive: true });
		}
	} catch (e) {
		reportLoggerFailure(e, "Failed to create logs directory for sync write");
	}

	rotateDebugLogIfNeededSync(logsDir, debugLogPath);

	try {
		fs.appendFileSync(debugLogPath, fileLine);
	} catch (e) {
		reportLoggerFailure(e, "Failed sync write to debug log");
	}

	const normalLevels = ["info", "success", "warn", "error"];
	if (normalLevels.includes(level)) {
		try {
			fs.appendFileSync(currentLogPath, fileLine);
		} catch (e) {
			reportLoggerFailure(e, "Failed sync write to current log");
		}
	}
}

function close() {
	if (flushInterval) {
		clearInterval(flushInterval);
		flushInterval = null;
	}
	if (debugStream) {
		try {
			debugStream.end();
		} catch (e) {
			reportLoggerFailure(e, "Failed to close debug stream");
		}
		debugStream = null;
	}
	if (normalStream) {
		try {
			normalStream.end();
		} catch (e) {
			reportLoggerFailure(e, "Failed to close current stream");
		}
		normalStream = null;
	}
	initialized = false;
}

function flush() {
	for (const stream of [debugStream, normalStream]) {
		if (stream && stream.writable) {
			try {
				const fd = stream.fd;
				if (fd != null) {
					fs.fsyncSync(fd);
				}
			} catch (e) {
				reportLoggerFailure(e, "Failed to flush stream");
			}
		}
	}
}

installConsoleTimestamps();

module.exports = {
	init,
	write,
	writeSync,
	close,
	flush,
	stripAnsi,
	reportLoggerFailure,
};
