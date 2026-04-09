const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// Ленивая загрузка helper.js для разрыва циклической зависимости
// (helper.js требует db.js, а db.js требует logMessage из helper.js)
let _logMessage = null;
let _filterString = null;
const logMessage = () => {
	if (!_logMessage) {
		_logMessage = require("./helper").logMessage;
	}
	return _logMessage;
};

const filterString = (value) => {
	if (!_filterString) {
		_filterString = require("./helper").filterString;
	}
	return _filterString(value);
};

// Структура для хранения открытых соединений с БД для каждого канала
const dbConnections = new Map();

const getDbPath = (outputFolder) => path.join(outputFolder, "messages.db");
const getRawMessagesPath = (outputFolder) => path.join(outputFolder, "raw_message.json");
const getProcessedMessagesPath = (outputFolder) => path.join(outputFolder, "all_message.json");

const normalizeStoredMediaPath = (mediaPath, outputFolder) => {
	if (!mediaPath || typeof mediaPath !== "string") {
		return null;
	}

	if (!path.isAbsolute(mediaPath)) {
		return mediaPath.replace(/[\\/]+/g, path.sep);
	}

	if (!outputFolder) {
		return mediaPath;
	}

	const relativePath = path.relative(outputFolder, mediaPath);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return mediaPath;
	}

	return relativePath;
};

const getStoredMediaPathVariants = (mediaPath, outputFolder) => {
	const variants = new Set();
	const normalizedPath = normalizeStoredMediaPath(mediaPath, outputFolder);

	if (normalizedPath) {
		variants.add(normalizedPath);
		variants.add(normalizedPath.replace(/\\/g, "/"));
		variants.add(normalizedPath.replace(/\//g, "\\"));
	}

	if (mediaPath && typeof mediaPath === "string" && path.isAbsolute(mediaPath)) {
		variants.add(mediaPath);
	}

	return variants;
};

const buildStoredMediaPathFromPayload = (processedData) => {
	if (!processedData || !processedData.mediaName || !processedData.mediaType) {
		return null;
	}

	return path.join(filterString(processedData.mediaType), processedData.mediaName);
};

const normalizeProcessedMessage = (processedData, outputFolder) => {
	if (!processedData || typeof processedData !== "object") {
		return { processedData, changed: false };
	}

	const fallbackRelativePath = buildStoredMediaPathFromPayload(processedData);
	const normalizedMediaPath = normalizeStoredMediaPath(processedData.mediaPath, outputFolder) || fallbackRelativePath;

	if (!normalizedMediaPath || normalizedMediaPath === processedData.mediaPath) {
		return { processedData, changed: false };
	}

	return {
		processedData: {
			...processedData,
			mediaPath: normalizedMediaPath,
		},
		changed: true,
	};
};

const migrateStoredMediaPaths = (db, outputFolder) => {
	let migratedCount = 0;
	const selectRows = db.prepare("SELECT id, processed_json FROM messages WHERE processed_json IS NOT NULL");
	const updateRow = db.prepare("UPDATE messages SET processed_json = ? WHERE id = ?");

	const migrate = db.transaction(() => {
		for (const row of selectRows.iterate()) {
			try {
				const processedData = JSON.parse(row.processed_json);
				const normalized = normalizeProcessedMessage(processedData, outputFolder);
				if (!normalized.changed) {
					continue;
				}

				updateRow.run(JSON.stringify(normalized.processedData), row.id);
				migratedCount++;
			} catch (e) {
				// Пропускаем записи с битым JSON, не мешая запуску приложения.
			}
		}
	});

	migrate();
	if (migratedCount > 0) {
		logMessage().db(`[DB] Migrated ${migratedCount} stored media paths to relative format`);
	}
};

/**
 * Инициализирует базу данных SQLite для указанного канала
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @returns {Database.Database} Объект базы данных
 */
const initDatabase = (channelId, outputFolder) => {
	const dbPath = getDbPath(outputFolder);
	
	logMessage().db(`[DB] initDatabase: channelId=${channelId}, dbPath=${dbPath}`);
	
	// Проверяем, есть ли уже открытое соединение
	if (dbConnections.has(dbPath)) {
		logMessage().db(`[DB] Reusing existing connection for ${dbPath}`);
		return dbConnections.get(dbPath);
	}
	
	// Создаем директорию, если не существует
	if (!fs.existsSync(outputFolder)) {
		logMessage().db(`[DB] Creating output directory: ${outputFolder}`);
		fs.mkdirSync(outputFolder, { recursive: true });
	}
	
	// Открываем/создаем базу данных
	const startTime = Date.now();
	const db = new Database(dbPath);
	const initTime = Date.now() - startTime;
	logMessage().db(`[DB] Database opened in ${initTime}ms: ${dbPath}`);
	
	// Включаем WAL режим для лучшей производительности
	logMessage().db(`[DB] Setting PRAGMA journal_mode=WAL`);
	db.pragma("journal_mode = WAL");
	
	// Создаем таблицу, если не существует
	logMessage().db(`[DB] Creating tables if not exist`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER NOT NULL,
			date INTEGER,
			raw_json TEXT,
			processed_json TEXT,
			downloaded INTEGER DEFAULT 0,
			PRIMARY KEY (id)
		)
	`);
	
	// Миграция: добавляем колонку downloaded, если её нет (для старых баз)
	try {
		const tableInfo = db.prepare("PRAGMA table_info(messages)").all();
		const hasDownloadedColumn = tableInfo.some(col => col.name === 'downloaded');
		if (!hasDownloadedColumn) {
			logMessage().db(`[DB] Migration: adding 'downloaded' column`);
			db.exec("ALTER TABLE messages ADD COLUMN downloaded INTEGER DEFAULT 0");
		} else {
			logMessage().db(`[DB] Migration check: 'downloaded' column exists`);
		}
	} catch (e) {
		logMessage().db(`[DB] Migration check skipped or column exists: ${e.message}`);
	}
	
	// Создаем индекс для быстрой сортировки по дате
	logMessage().db(`[DB] Creating indexes if not exist`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)
	`);

	migrateStoredMediaPaths(db, outputFolder);
	
	// Сохраняем соединение в кэш
	dbConnections.set(dbPath, db);
	logMessage().db(`[DB] Connection cached. Total connections: ${dbConnections.size}`);
	
	return db;
};

/**
 * Получает объект базы данных для указанного канала
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @returns {Database.Database|null} Объект базы данных или null
 */
const getDatabase = (channelId, outputFolder) => {
	const dbPath = getDbPath(outputFolder);
	const db = dbConnections.get(dbPath) || null;
	logMessage().db(`[DB] getDatabase: channelId=${channelId}, found=${!!db}, path=${dbPath}`);
	return db;
};

/**
 * Сохраняет пачку сообщений в базу данных
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {Array} rawMessages - Массив сырых сообщений от Telegram API
 * @param {Array} processedMessages - Массив обработанных сообщений (упрощенный формат)
 */
const saveMessages = (channelId, outputFolder, rawMessages, processedMessages) => {
	const startTime = Date.now();
	const db = initDatabase(channelId, outputFolder);
	
	logMessage().db(`[DB] saveMessages: channelId=${channelId}, rawCount=${rawMessages.length}, processedCount=${processedMessages.length}`);
	
	// Используем INSERT ... ON CONFLICT DO UPDATE, чтобы не затирать статус downloaded
	const insertRaw = db.prepare(`
		INSERT INTO messages (id, date, raw_json, processed_json, downloaded)
		VALUES (?, ?, ?, ?, (SELECT downloaded FROM messages WHERE id = ?))
		ON CONFLICT(id) DO UPDATE SET
			date = excluded.date,
			raw_json = excluded.raw_json,
			processed_json = excluded.processed_json,
			downloaded = COALESCE((SELECT downloaded FROM messages WHERE id = excluded.id), 0)
	`);
	
	let insertedCount = 0;
	let updatedCount = 0;
	
	const insertMany = db.transaction((raw, processed) => {
		// Создаем Map для быстрого поиска обработанных сообщений по ID
		const processedMap = new Map();
		processed.forEach(msg => {
			if (msg && msg.id) {
				processedMap.set(msg.id, msg);
			}
		});
		
		for (const rawMsg of raw) {
			if (!rawMsg || !rawMsg.id) continue;
			
			const processedMsg = processedMap.get(rawMsg.id);
			const dateTimestamp = rawMsg.date ? new Date(rawMsg.date).getTime() : null;
			
			const result = insertRaw.run(
				rawMsg.id,
				dateTimestamp,
				JSON.stringify(rawMsg),
				processedMsg ? JSON.stringify(processedMsg) : null,
				rawMsg.id // Для SELECT downloaded FROM messages WHERE id = ?
			);
			
			// SQLite returns changes > 0 if a new row was inserted or updated
			if (result.changes > 0) {
				// Check if it was actually an insert or update
				// This is approximate since ON CONFLICT always results in changes=1 on conflict
				insertedCount++;
			}
		}
	});
	
	insertMany(rawMessages, processedMessages);
	const elapsed = Date.now() - startTime;
	
	logMessage().db(`[DB] saveMessages complete: inserted/updated=${insertedCount}, time=${elapsed}ms`);
};

/**
 * Проверяет, существует ли сообщение с указанным ID
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {number} messageId - ID сообщения
 * @returns {boolean}
 */
const messageExists = (channelId, outputFolder, messageId) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] messageExists: channelId=${channelId}, msgId=${messageId}, result=NULL_DB`);
		return false;
	}
	
	const startTime = Date.now();
	const result = db.prepare("SELECT 1 FROM messages WHERE id = ?").get(messageId);
	const elapsed = Date.now() - startTime;
	const exists = !!result;
	
	logMessage().db(`[DB] messageExists: msgId=${messageId}, exists=${exists}, time=${elapsed}ms`);
	return exists;
};

/**
 * Получает количество сообщений в базе данных
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @returns {number}
 */
const getMessageCount = (channelId, outputFolder) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) return 0;
	
	const startTime = Date.now();
	const result = db.prepare("SELECT COUNT(*) as count FROM messages").get();
	const elapsed = Date.now() - startTime;
	const count = result ? result.count : 0;
	
	logMessage().db(`[DB] getMessageCount: channelId=${channelId}, count=${count}, time=${elapsed}ms`);
	return count;
};

/**
 * Получает все сообщения для экспорта в старом формате
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {string} type - Тип экспорта: 'raw', 'processed', или 'all'
 * @yields {Object} Объект сообщения
 */
function* getMessagesForExport(channelId, outputFolder, type = "all") {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] getMessagesForExport: channelId=${channelId}, type=${type}, result=NULL_DB`);
		return;
	}
	
	const query = type === "raw" 
		? "SELECT id, date, raw_json FROM messages ORDER BY id ASC"
		: type === "processed"
			? "SELECT id, date, processed_json FROM messages ORDER BY id ASC"
			: "SELECT id, date, raw_json, processed_json FROM messages ORDER BY id ASC";
	
	logMessage().db(`[DB] getMessagesForExport: channelId=${channelId}, type=${type}, query started`);
	const stmt = db.prepare(query);
	
	let count = 0;
	for (const row of stmt.iterate()) {
		yield row;
		count++;
	}
	logMessage().db(`[DB] getMessagesForExport: yielded ${count} rows`);
}

/**
 * Экспортирует данные из SQLite обратно в JSON Lines формат
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 */
const exportToJsonFiles = (channelId, outputFolder) => {
	const rawFilePath = getRawMessagesPath(outputFolder);
	const processedFilePath = getProcessedMessagesPath(outputFolder);
	
	logMessage().db(`[DB] exportToJsonFiles: channelId=${channelId}`);
	
	// Очищаем существующие файлы
	if (fs.existsSync(rawFilePath)) {
		logMessage().db(`[DB] Deleting existing raw file: ${rawFilePath}`);
		fs.unlinkSync(rawFilePath);
	}
	if (fs.existsSync(processedFilePath)) {
		logMessage().db(`[DB] Deleting existing processed file: ${processedFilePath}`);
		fs.unlinkSync(processedFilePath);
	}
	
	let count = 0;
	const startTime = Date.now();
	
	for (const row of getMessagesForExport(channelId, outputFolder, "all")) {
		// Экспортируем raw_json
		if (row.raw_json) {
			fs.appendFileSync(rawFilePath, row.raw_json + "\n");
		}
		
		// Экспортируем processed_json
		if (row.processed_json) {
			fs.appendFileSync(processedFilePath, row.processed_json + "\n");
		}
		
		count++;
	}
	
	const elapsed = Date.now() - startTime;
	logMessage().db(`[DB] exportToJsonFiles: exported ${count} rows in ${elapsed}ms`);
	
	return count;
};

/**
 * Закрывает все открытые соединения с базой данных
 */
const closeAllConnections = () => {
	logMessage().db(`[DB] closeAllConnections: closing ${dbConnections.size} connections`);
	for (const [dbPath, db] of dbConnections) {
		try {
			db.close();
			logMessage().db(`[DB] Closed connection: ${dbPath}`);
		} catch (e) {
			logMessage().error(`[DB] Error closing database ${dbPath}: ${e.message}`);
		}
	}
	dbConnections.clear();
	logMessage().db(`[DB] All connections closed`);
};

/**
 * Закрывает соединение с базой данных для указанного канала
 * @param {string} outputFolder - Путь к папке экспорта
 */
const closeDatabase = (outputFolder) => {
	const channelId = path.basename(outputFolder);
	const dbPath = getDbPath(outputFolder);
	
	logMessage().db(`[DB] closeDatabase: channelId=${channelId}, path=${outputFolder}`);
	
	if (dbConnections.has(dbPath)) {
		try {
			dbConnections.get(dbPath).close();
			dbConnections.delete(dbPath);
			logMessage().db(`[DB] Connection closed: ${dbPath}, remaining=${dbConnections.size}`);
		} catch (e) {
			logMessage().error(`[DB] Error closing database ${dbPath}: ${e.message}`);
		}
	} else {
		logMessage().db(`[DB] No connection found for: ${dbPath}`);
	}
};

/**
 * Устанавливает флаг downloaded для сообщения
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {number} messageId - ID сообщения
 * @param {number} status - Статус загрузки (1 = скачано, 0 = не скачано)
 */
const setFileDownloaded = (channelId, outputFolder, messageId, status = 1) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] setFileDownloaded: channelId=${channelId}, msgId=${messageId}, status=${status}, result=NULL_DB`);
		return false;
	}
	
	const startTime = Date.now();
	try {
		const result = db.prepare("UPDATE messages SET downloaded = ? WHERE id = ?").run(status, messageId);
		const elapsed = Date.now() - startTime;
		const changes = result ? result.changes : 0;
		
		logMessage().db(`[DB] setFileDownloaded: msgId=${messageId}, status=${status}, changes=${changes}, time=${elapsed}ms`);
		return changes > 0;
	} catch (e) {
		logMessage().error(`[DB] Error setting downloaded flag for message ${messageId}: ${e.message}`);
		return false;
	}
};

/**
 * Проверяет, отмечен ли файл как скачанный в базе данных
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {number} messageId - ID сообщения
 * @returns {boolean}
 */
const isFileDownloaded = (channelId, outputFolder, messageId) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] isFileDownloaded: channelId=${channelId}, msgId=${messageId}, result=NULL_DB`);
		return false;
	}
	
	const startTime = Date.now();
	const result = db.prepare("SELECT downloaded FROM messages WHERE id = ?").get(messageId);
	const elapsed = Date.now() - startTime;
	const downloaded = result ? result.downloaded === 1 : false;
	
	logMessage().db(`[DB] isFileDownloaded: msgId=${messageId}, downloaded=${downloaded}, time=${elapsed}ms`);
	return downloaded;
};

/**
 * Синхронизирует статус downloaded для всех сообщений с медиа на основе снапшотов
 * Помечает файлы из снапшотов как скачанные
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {Set<string>} snapshotFiles - Множество относительных путей файлов из снапшотов
 * @returns {number} Количество обновленных записей
 */
const syncDownloadedFromSnapshots = (channelId, outputFolder, snapshotFiles) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] syncDownloadedFromSnapshots: channelId=${channelId}, snapshots=${snapshotFiles.size}, result=NULL_DB`);
		return 0;
	}
	
	logMessage().db(`[DB] syncDownloadedFromSnapshots: channelId=${channelId}, snapshotCount=${snapshotFiles.size}`);
	
	let updatedCount = 0;
	let processedCount = 0;
	
	const startTime = Date.now();
	const updateMany = db.transaction(() => {
		for (const row of db.prepare("SELECT id, processed_json FROM messages WHERE downloaded = 0").iterate()) {
			processedCount++;
			try {
				const processedData = row.processed_json ? JSON.parse(row.processed_json) : null;
				const normalized = normalizeProcessedMessage(processedData, outputFolder);
				const mediaPath = normalized.processedData ? normalized.processedData.mediaPath : null;
				const mediaPathVariants = mediaPath
					? getStoredMediaPathVariants(mediaPath, outputFolder)
					: new Set();
				const foundInSnapshots = [...mediaPathVariants].some((storedPath) => snapshotFiles.has(storedPath));
				if (foundInSnapshots) {
					db.prepare("UPDATE messages SET downloaded = 1 WHERE id = ?").run(row.id);
					updatedCount++;
				}
			} catch (e) {
				// Пропускаем сообщения с ошибками парсинга
			}
		}
	});
	
	updateMany();
	const elapsed = Date.now() - startTime;
	
	logMessage().db(`[DB] syncDownloadedFromSnapshots: processed=${processedCount} rows, updated=${updatedCount}, time=${elapsed}ms`);
	return updatedCount;
};

module.exports = {
	initDatabase,
	getDatabase,
	saveMessages,
	messageExists,
	getMessageCount,
	getMessagesForExport,
	exportToJsonFiles,
	closeAllConnections,
	closeDatabase,
	setFileDownloaded,
	isFileDownloaded,
	syncDownloadedFromSnapshots,
};
