const mimeDB = require("mime-db");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const logger = require("./logger");

// Кэш проверки файлов: Map<filePath, {exists: boolean, size: number}>
let fileCheckCache = new Map();
let snapshotsCache = new Map();

class DownloadState {
	constructor() {
		this.downloadedIds = new Set();
		this.undownloadedMediaPaths = new Map();
		this.initialized = false;
		this.outputFolder = null;
		this.snapshotFiles = new Set();
	}

	init(channelId, outputFolder) {
		if (this.initialized && this.outputFolder === outputFolder) {
			return;
		}
		this.outputFolder = outputFolder;
		this.downloadedIds = db.getDownloadedSet(channelId, outputFolder);
		this.undownloadedMediaPaths = db.getMediaPathMap(channelId, outputFolder);
		this.snapshotFiles = loadSnapshots(outputFolder);
		this.initialized = true;
		logMessage.cache(
			`[DownloadState] Initialized: downloaded=${this.downloadedIds.size}, ` +
			`undownloadedMedia=${this.undownloadedMediaPaths.size}, snapshots=${this.snapshotFiles.size}`
		);
	}

	markDownloaded(messageId) {
		this.downloadedIds.add(messageId);
	}

	isDownloaded(messageId) {
		return this.downloadedIds.has(messageId);
	}

	hasSnapshot(relativePath) {
		if (this.snapshotFiles.has(relativePath)) return true;
		const forward = relativePath.replace(/\\/g, "/");
		if (this.snapshotFiles.has(forward)) return true;
		const backward = relativePath.replace(/\//g, "\\");
		if (this.snapshotFiles.has(backward)) return true;
		return false;
	}

	findUndownloadedByPath(relativePath) {
		if (this.undownloadedMediaPaths.has(relativePath)) {
			return this.undownloadedMediaPaths.get(relativePath);
		}
		const forward = relativePath.replace(/\\/g, "/");
		if (this.undownloadedMediaPaths.has(forward)) {
			return this.undownloadedMediaPaths.get(forward);
		}
		const backward = relativePath.replace(/\//g, "\\");
		if (this.undownloadedMediaPaths.has(backward)) {
			return this.undownloadedMediaPaths.get(backward);
		}
		return null;
	}
}

const downloadState = new DownloadState();

const SNAPSHOTS_DIR = "snapshots";

// Define media types
const MEDIA_TYPES = {
	IMAGE: "image",
	VIDEO: "video",
	AUDIO: "audio",
	WEBPAGE: "webpage",
	POLL: "poll",
	GEO: "geo",
	VENUE: "venue",
	CONTACT: "contact",
	STICKER: "sticker",
	DOCUMENT: "document",
	OTHERS: "others",
};

let consoleColors = {
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	reset: "\x1b[0m",
};

const LOG_LEVELS = {
	debug: 10,
	info: 20,
	success: 20,
	warn: 25,
	error: 30,
};

const DEBUG_FLAG = process.argv.includes("--debug");
const CURRENT_LOG_LEVEL = DEBUG_FLAG ? "debug" : (process.env.LOG_LEVEL || "info");

const shouldLog = (level) =>
	LOG_LEVELS[level] >= (LOG_LEVELS[CURRENT_LOG_LEVEL] || LOG_LEVELS.info);

const LOG_PREFIXES = {
	auth: '[AUTH]',
	db: '[DB]',
	fetch: '[FETCH]',
	dl: '[DL]',
	flood: '[FLOOD]',
	valid: '[VALID]',
	init: '[INIT]',
	dialog: '[DIALOG]',
	filter: '[FILTER]',
	cache: '[CACHE]',
};

const logMessage = {
	info: (message) => {
		const line = `ℹ️  ${consoleColors.blue} ${message} ${consoleColors.reset}`;
		console.log(line);
		logger.write("info", line);
	},
	error: (message) => {
		const line = `❌ ${consoleColors.red} ${message} ${consoleColors.reset}`;
		console.log(line);
		logger.write("error", line);
	},
	success: (message) => {
		const line = `✅ ${consoleColors.green} ${message} ${consoleColors.reset}`;
		console.log(line);
		logger.write("success", line);
	},
	warn: (message) => {
		const line = `⚠️  ${consoleColors.yellow} ${message} ${consoleColors.reset}`;
		console.log(line);
		logger.write("warn", line);
	},
	debug: (message) => {
		const line = `🔍 ${consoleColors.cyan} ${message} ${consoleColors.reset}`;
		logger.write("debug", line);
		if (shouldLog("debug")) {
			console.log(line);
		}
	},

	auth: (message) => logMessage.debug(`${LOG_PREFIXES.auth} ${message}`),
	db: (message) => logMessage.debug(`${LOG_PREFIXES.db} ${message}`),
	fetch: (message) => logMessage.debug(`${LOG_PREFIXES.fetch} ${message}`),
	dl: (message) => logMessage.debug(`${LOG_PREFIXES.dl} ${message}`),
	flood: (message) => logMessage.debug(`${LOG_PREFIXES.flood} ${message}`),
	valid: (message) => logMessage.debug(`${LOG_PREFIXES.valid} ${message}`),
	init: (message) => logMessage.debug(`${LOG_PREFIXES.init} ${message}`),
	dialog: (message) => logMessage.debug(`${LOG_PREFIXES.dialog} ${message}`),
	filter: (message) => logMessage.debug(`${LOG_PREFIXES.filter} ${message}`),
	cache: (message) => logMessage.debug(`${LOG_PREFIXES.cache} ${message}`),
};

const getMediaType = (message) => {
	if (message.media) {
		if (message.media.photo) return MEDIA_TYPES.IMAGE;
		if (message.media.video) return MEDIA_TYPES.VIDEO;
		if (message.media.audio) return MEDIA_TYPES.AUDIO;
		if (message.media.webpage) return MEDIA_TYPES.WEBPAGE;
		if (message.media.poll) return MEDIA_TYPES.POLL;
		if (message.media.geo) return MEDIA_TYPES.GEO;
		if (message.media.contact) return MEDIA_TYPES.CONTACT;
		if (message.media.venue) return MEDIA_TYPES.VENUE;
		if (message.media.sticker) return MEDIA_TYPES.STICKER;
		if (message.media.document) {
			const documentMimeType = message.media.document.mimeType;
			if (documentMimeType) {
				if (documentMimeType?.includes(MEDIA_TYPES.IMAGE)) {
					return MEDIA_TYPES.IMAGE;
				}
				if (documentMimeType?.includes(MEDIA_TYPES.VIDEO)) {
					return MEDIA_TYPES.VIDEO;
				}
				if (documentMimeType?.includes(MEDIA_TYPES.AUDIO)) {
					return MEDIA_TYPES.AUDIO;
				}
				if (documentMimeType?.includes(MEDIA_TYPES.STICKER)) {
					return MEDIA_TYPES.STICKER;
				}
			}

			return MEDIA_TYPES.DOCUMENT;
		}
	}

	return MEDIA_TYPES.OTHERS;
};

// Генерация имени файла на основе сообщения (используется в checkFileExist и getMediaPath)
const buildFileName = (message) => {
	let fileName = `file_${message.id}`;
	if (message.media.document) {
		let docAttributes = message?.media?.document?.attributes;
		if (docAttributes) {
			let fileNameObj = docAttributes.find(
				(e) => e.className == "DocumentAttributeFilename"
			);
			if (fileNameObj) {
				fileName = `file_${message.id}_${fileNameObj.fileName}`;
			} else {
				let ext =
					mimeDB[message.media.document.mimeType]?.extensions[0];
				if (ext) {
					fileName += "." + ext;
				}
			}
		}
	}

	if (message.media.video) {
		fileName = fileName + ".mp4";
	}
	if (message.media.audio) {
		fileName = fileName + ".mp3";
	}
	if (message.media.photo) {
		fileName = fileName + ".jpg";
	}

	return fileName;
};

/**
 * Load and cache snapshots from the snapshots directory for a given channel path
 * @param {string} channelPath - Path to the channel folder
 * @returns {Set<string>} Set of relative file paths from all snapshots
 */
const loadSnapshots = (channelPath) => {
	if (snapshotsCache.has(channelPath)) {
		return snapshotsCache.get(channelPath);
	}

	const snapshotsPath = path.join(channelPath, SNAPSHOTS_DIR);
	const fixedFiles = new Set();

	if (!fs.existsSync(snapshotsPath)) {
		snapshotsCache.set(channelPath, fixedFiles);
		return fixedFiles;
	}

	try {
		const files = fs.readdirSync(snapshotsPath);
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const filePath = path.join(snapshotsPath, file);
			try {
				const content = fs.readFileSync(filePath, "utf8");
				const snapshot = JSON.parse(content);
				if (snapshot.files) {
					for (const filePath in snapshot.files) {
						fixedFiles.add(filePath);
					}
				}
			} catch (e) {
				// Skip invalid JSON files
			}
		}
	} catch (e) {
		logMessage.error(`Error reading snapshots from ${snapshotsPath}: ${e.message}`);
	}

	snapshotsCache.set(channelPath, fixedFiles);
	return fixedFiles;
};

// Проверка существования файла с оптимизированным порядком проверок:
// 1. Кэш (самый быстрый)
// 2. Снапшоты (без обращения к диску и БД)
// 3. БД (SQLite запрос)
// 4. Диск (только если БД не дала информации)
const checkFileExist = (message, outputFolder, channelId = null) => {
	if (!message) return false;
	if (!message.media) return false;

	const fileName = buildFileName(message);
	const folderType = filterString(getMediaType(message));
	const filePath = path.join(outputFolder, folderType, fileName);
	const relativePath = path.join(folderType, fileName);

	// 1. In-memory cache (fastest)
	if (fileCheckCache.has(filePath)) {
		const cached = fileCheckCache.get(filePath);
		if (message && cached.fromSnapshot !== undefined) {
			message._fromSnapshot = cached.fromSnapshot;
		}
		return cached.exists && cached.size > 0;
	}

	// 2. DB-based check via preloaded DownloadState
	if (channelId && downloadState.initialized) {
		// 2a. Message already downloaded
		if (downloadState.isDownloaded(message.id)) {
			fileCheckCache.set(filePath, { exists: true, size: 0, fromSnapshot: false });
			return true;
		}

		// 2b. Snapshot knows this file
		if (downloadState.hasSnapshot(relativePath)) {
			if (message) message._fromSnapshot = true;
			fileCheckCache.set(filePath, { exists: true, size: 0, fromSnapshot: true });
			return true;
		}

		// 2c. File not in DB as downloaded and not in snapshots
		// => Only check disk if we have a media path mapped as undownloaded
		// (avoids fs.existsSync for messages DB already knows about)
		const foundInUndownloaded = downloadState.findUndownloadedByPath(relativePath);
		if (foundInUndownloaded !== null) {
			// DB says not downloaded, snapshot says not found → check disk once
			if (fs.existsSync(filePath)) {
				const stats = fs.statSync(filePath);
				if (stats.size > 0) {
					fileCheckCache.set(filePath, { exists: true, size: stats.size, fromSnapshot: false });
					return true;
				}
			}
			fileCheckCache.set(filePath, { exists: false, size: 0 });
			return false;
		}

		// 2d. Message not in preloaded sets at all (new message from API)
		// Fall through to disk check
	}

	// 3. Fallback: single DB query (when DownloadState not initialized)
	if (channelId && !downloadState.initialized) {
		const markedAsDownloaded = db.isFileDownloaded(channelId, outputFolder, message.id);
		if (markedAsDownloaded) {
			fileCheckCache.set(filePath, { exists: true, size: 0, fromSnapshot: false });
			return true;
		}
	}

	// 4. Disk check (last resort)
	if (fs.existsSync(filePath)) {
		const stats = fs.statSync(filePath);
		if (stats.size > 0) {
			fileCheckCache.set(filePath, { exists: true, size: stats.size, fromSnapshot: false });
			return true;
		}
		fileCheckCache.set(filePath, { exists: false, size: 0 });
		return false;
	}

	fileCheckCache.set(filePath, { exists: false, size: 0 });
	return false;
};

// Очистка кэша проверки файлов
const clearFileCheckCache = () => {
	fileCheckCache.clear();
};

// Очистка кэша снимков
const clearSnapshotsCache = () => {
	snapshotsCache.clear();
};

// Добавление файла в кэш после скачивания
const addFileToCheckCache = (filePath, size) => {
	fileCheckCache.set(filePath, { exists: true, size });
};

const initDownloadState = (channelId, outputFolder) => {
	downloadState.init(channelId, outputFolder);
};

const getMediaRelativePath = (message) => {
	if (!message || !message.media) return null;

	const fileName = buildFileName(message);
	const folderType = filterString(getMediaType(message));
	return path.join(folderType, fileName);
};

// Get the path to save the media file
const getMediaPath = (message, outputFolder) => {
	if (!message) return;

	if (message.media) {
		const relativePath = getMediaRelativePath(message);
		const filePath = path.join(outputFolder, relativePath);
		const mediaDir = path.dirname(filePath);
		if (!fs.existsSync(mediaDir)) {
			fs.mkdirSync(mediaDir, { recursive: true });
		}

		return filePath;
	} else {
		return "unknown";
	}
};

// Get the type of dialog
const getDialogType = (dialog) => {
	if (dialog.isChannel) return "Channel";
	if (dialog.isGroup) return "Group";
	if (dialog.isUser) return "User";
	return "Unknown";
};

const wait = (second) => {
	//logMessage.debug(`Waiting for ${second} seconds to avoid blocking`);
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve();
		}, second * 1000);
	});
};

// Filter a string to remove non-alphanumeric characters
const filterString = (string) => {
	return string.replace(/[^a-zA-Z0-9]/g, "");
};

const circularStringify = (circularString, indent = 2) => {
	let cache = [];
	const retVal = JSON.stringify(
		circularString,
		(key, value) =>
			typeof value === "object" && value !== null
				? cache.includes(value)
					? undefined // Duplicate reference found, discard key
					: cache.push(value) && value // Store value in our collection
				: value,
		indent
	);
	cache = null;
	return retVal;
};

module.exports = {
	getMediaType,
	checkFileExist,
	getMediaPath,
	getMediaRelativePath,
	getDialogType,
	logMessage,
	wait,
	buildFileName,
	filterString,
	clearFileCheckCache,
	addFileToCheckCache,
	initDownloadState,
	downloadState,
	fileCheckCache,
	loadSnapshots,
	circularStringify,
	shouldLog,
	LOG_LEVELS,
	consoleColors,
	MEDIA_TYPES,
};
