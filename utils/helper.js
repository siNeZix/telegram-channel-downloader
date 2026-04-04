const mimeDB = require("mime-db");
const fs = require("fs");
const path = require("path");

// Кэш проверки файлов: Map<filePath, {exists: boolean, size: number}>
let fileCheckCache = new Map();

// Кэш снимков: Map<channelPath, Set<relativeFilePath>>
let snapshotsCache = new Map();

const SNAPSHOTS_DIR = "snapshots";

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
	error: 30,
};
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || "info";
const shouldLog = (level) =>
	LOG_LEVELS[level] >= (LOG_LEVELS[CURRENT_LOG_LEVEL] || LOG_LEVELS.info);

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

// Проверка существования файла с кэшированием и проверкой размера
const checkFileExist = (message, outputFolder) => {
	if (!message) return false;

	if (!message.media) return false;

	const fileName = buildFileName(message);
	const folderType = filterString(getMediaType(message));
	const filePath = path.join(outputFolder, folderType, fileName);
	const relativePath = path.join(folderType, fileName);

	// Проверяем кэш
	if (fileCheckCache.has(filePath)) {
		const cached = fileCheckCache.get(filePath);
		return cached.exists && cached.size > 0;
	}

	// Проверяем файл
	try {
		if (fs.existsSync(filePath)) {
			const stats = fs.statSync(filePath);
			const exists = stats.size > 0;
			fileCheckCache.set(filePath, { exists, size: stats.size });
			return exists;
		}
	} catch (err) {
		logMessage.error(`Error checking file ${filePath}: ${err.message}`);
	}

	// Проверяем в снимках
	const snapshots = loadSnapshots(outputFolder);
	if (snapshots.has(relativePath)) {
		fileCheckCache.set(filePath, { exists: true, size: 1 }); // Кэшируем как существующий
		return true;
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

const getMediaPath = (message, outputFolder) => {
	if (!message) return;

	if (message.media) {
		const fileName = buildFileName(message);
		const folderType = filterString(getMediaType(message));
		outputFolder = path.join(outputFolder, folderType);
		const filePath = path.join(outputFolder, fileName);
		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder);
		}

		return filePath;
	} else {
		return "unknown";
	}
};

const getDialogType = (dialog) => {
	if (dialog.isChannel) return "Channel";
	if (dialog.isGroup) return "Group";
	if (dialog.isUser) return "User";
	return "Unknown";
};

const logMessage = {
	info: (message) => {
		if (!shouldLog("info")) return;
		let logMessage = `📢: ${consoleColors.magenta} ${message} ${consoleColors.reset}`;
		console.log(logMessage);
	},
	error: (message) => {
		if (!shouldLog("error")) return;
		let logMessage = `❌ ${consoleColors.red} ${message} ${consoleColors.reset}`;
		console.log(logMessage);
	},
	success: (message) => {
		if (!shouldLog("success")) return;
		let logMessage = `✅ ${consoleColors.cyan} ${message} ${consoleColors.reset}`;
		console.log(logMessage);
	},
	debug: (message) => {
		if (!shouldLog("debug")) return;
		let logMessage = `⚠️ ${message}`;
		console.log(logMessage);
	},
	warn: (message) => {
		if (!shouldLog("warn")) return;
		let logMessage = `⚠️ ${consoleColors.yellow} ${message} ${consoleColors.reset}`;
		console.log(logMessage);
	},
};

const wait = (second) => {
	//logMessage.debug(`Waiting for ${second} seconds to avoid blocking`);
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve();
		}, second * 1000);
	});
};

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
	getDialogType,
	logMessage,
	wait,
	filterString,
	circularStringify,
	clearFileCheckCache,
	clearSnapshotsCache,
	addFileToCheckCache,
	buildFileName,
	MEDIA_TYPES,
	fileCheckCache,
};
