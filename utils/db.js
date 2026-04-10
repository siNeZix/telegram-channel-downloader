const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

let _helper = null;
const helper = () => {
	if (!_helper) {
		_helper = require("./helper");
	}
	return _helper;
};

const logMessage = () => helper().logMessage;
const filterString = (value) => helper().filterString(value);
const getMediaRelativePath = (message) => helper().getMediaRelativePath(message);
const getMediaType = (message) => helper().getMediaType(message);

const dbConnections = new Map();

const getDbPath = (outputFolder) => path.join(outputFolder, "messages.db");
const getRawMessagesPath = (outputFolder) => path.join(outputFolder, "raw_message.json");
const getProcessedMessagesPath = (outputFolder) => path.join(outputFolder, "all_message.json");

const toTimestamp = (value) => {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	const dateValue = new Date(value).getTime();
	return Number.isFinite(dateValue) ? dateValue : null;
};

const toSqlInteger = (value) => {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	if (typeof value === "bigint") {
		return value;
	}

	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}

	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	if (typeof value.valueOf === "function") {
		const primitive = value.valueOf();
		if (primitive !== value) {
			return toSqlInteger(primitive);
		}
	}

	const textValue = String(value);
	if (/^-?\d+$/.test(textValue)) {
		try {
			return BigInt(textValue);
		} catch {
			const parsed = Number(textValue);
			return Number.isFinite(parsed) ? parsed : null;
		}
	}

	return null;
};

const parseJson = (value) => {
	if (!value || typeof value !== "string") {
		return null;
	}

	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
};

const normalizeMediaPath = (mediaPath, outputFolder) => {
	if (!mediaPath || typeof mediaPath !== "string") {
		return null;
	}

	if (!path.isAbsolute(mediaPath)) {
		return mediaPath.replace(/[\\/]+/g, path.sep);
	}

	const relativePath = path.relative(outputFolder, mediaPath);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return null;
	}

	return relativePath;
};

const buildMediaPathFromColumns = (mediaType, mediaName) => {
	if (!mediaType || !mediaName) {
		return null;
	}

	return path.join(filterString(mediaType), mediaName);
};

const getStoredMediaPathVariants = (mediaPath) => {
	const variants = new Set();
	if (!mediaPath) {
		return variants;
	}

	variants.add(mediaPath);
	variants.add(mediaPath.replace(/\\/g, "/"));
	variants.add(mediaPath.replace(/\//g, "\\"));
	return variants;
};

const getSenderId = (message) => message?.fromId?.userId || message?.peerId?.userId || null;

const extractRecordFromRawMessage = (rawMessage, outputFolder) => {
	if (!rawMessage || !rawMessage.id) {
		return null;
	}

	const hasMedia = !!rawMessage.media;
	const mediaPath = hasMedia ? getMediaRelativePath(rawMessage) : null;
	const mediaType = hasMedia ? getMediaType(rawMessage) : null;

	return {
		id: rawMessage.id,
		date: toTimestamp(rawMessage.date),
		message_text: rawMessage.message ?? null,
		is_out: rawMessage.out === undefined ? null : (rawMessage.out ? 1 : 0),
		sender_id: toSqlInteger(getSenderId(rawMessage)),
		has_media: hasMedia ? 1 : 0,
		media_type: mediaType || null,
		media_path: mediaPath,
		media_name: mediaPath ? path.basename(mediaPath) : null,
	};
};

const extractRecordFromProcessedMessage = (processedMessage, outputFolder) => {
	if (!processedMessage || !processedMessage.id) {
		return null;
	}

	const normalizedMediaPath = normalizeMediaPath(processedMessage.mediaPath, outputFolder);
	const fallbackMediaPath = buildMediaPathFromColumns(processedMessage.mediaType, processedMessage.mediaName);
	const mediaPath = normalizedMediaPath || fallbackMediaPath;
	const hasMedia = processedMessage.isMedia || !!mediaPath || !!processedMessage.mediaType || !!processedMessage.mediaName;

	return {
		id: processedMessage.id,
		date: toTimestamp(processedMessage.date),
		message_text: processedMessage.message ?? null,
		is_out: processedMessage.out === undefined ? null : (processedMessage.out ? 1 : 0),
		sender_id: toSqlInteger(processedMessage.sender),
		has_media: hasMedia ? 1 : 0,
		media_type: processedMessage.mediaType || null,
		media_path: mediaPath,
		media_name: processedMessage.mediaName || (mediaPath ? path.basename(mediaPath) : null),
	};
};

const extractRecordFromLegacyRow = (row, outputFolder) => {
	const rawMessage = parseJson(row.raw_json);
	const processedMessage = parseJson(row.processed_json);
	const rawRecord = extractRecordFromRawMessage(rawMessage, outputFolder) || { id: row.id };
	const processedRecord = extractRecordFromProcessedMessage(processedMessage, outputFolder) || { id: row.id };

	const merged = {
		id: row.id,
		date: processedRecord.date ?? rawRecord.date ?? row.date ?? null,
		message_text: processedRecord.message_text ?? rawRecord.message_text ?? null,
		is_out: processedRecord.is_out ?? rawRecord.is_out ?? null,
		sender_id: processedRecord.sender_id ?? rawRecord.sender_id ?? null,
		downloaded: row.downloaded ? 1 : 0,
		has_media: processedRecord.has_media ?? rawRecord.has_media ?? 0,
		media_type: processedRecord.media_type ?? rawRecord.media_type ?? null,
		media_path: processedRecord.media_path ?? rawRecord.media_path ?? null,
		media_name: processedRecord.media_name ?? rawRecord.media_name ?? null,
	};

	if (!merged.media_path) {
		merged.media_path = buildMediaPathFromColumns(merged.media_type, merged.media_name);
	}

	if (!merged.media_name && merged.media_path) {
		merged.media_name = path.basename(merged.media_path);
	}

	if (!merged.has_media && (merged.media_type || merged.media_path || merged.media_name)) {
		merged.has_media = 1;
	}

	return merged;
};

const createMessagesTable = (db, tableName = "messages") => {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${tableName} (
			id INTEGER PRIMARY KEY,
			date INTEGER,
			message_text TEXT,
			is_out INTEGER,
			sender_id INTEGER,
			downloaded INTEGER DEFAULT 0,
			has_media INTEGER DEFAULT 0,
			media_type TEXT,
			media_path TEXT,
			media_name TEXT
		)
	`);
};

const createIndexes = (db) => {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
		CREATE INDEX IF NOT EXISTS idx_messages_downloaded ON messages(downloaded);
		CREATE INDEX IF NOT EXISTS idx_messages_media_path ON messages(media_path);
	`);
};

const upsertStatements = new Map();

const getUpsertStatement = (db) => {
	const dbPath = db.name || "";
	if (upsertStatements.has(dbPath)) {
		return upsertStatements.get(dbPath);
	}
	const stmt = db.prepare(`
		INSERT INTO messages (
			id,
			date,
			message_text,
			is_out,
			sender_id,
			downloaded,
			has_media,
			media_type,
			media_path,
			media_name
		) VALUES (
			@id,
			@date,
			@message_text,
			@is_out,
			@sender_id,
			COALESCE((SELECT downloaded FROM messages WHERE id = @id), 0),
			@has_media,
			@media_type,
			@media_path,
			@media_name
		)
		ON CONFLICT(id) DO UPDATE SET
			date = COALESCE(excluded.date, messages.date),
			message_text = COALESCE(excluded.message_text, messages.message_text),
			is_out = COALESCE(excluded.is_out, messages.is_out),
			sender_id = COALESCE(excluded.sender_id, messages.sender_id),
			downloaded = COALESCE(messages.downloaded, 0),
			has_media = COALESCE(excluded.has_media, messages.has_media),
			media_type = COALESCE(excluded.media_type, messages.media_type),
			media_path = COALESCE(excluded.media_path, messages.media_path),
			media_name = COALESCE(excluded.media_name, messages.media_name)
	`);
	upsertStatements.set(dbPath, stmt);
	return stmt;
};

const isLegacyJsonSchema = (db) => {
	const tableInfo = db.prepare("PRAGMA table_info(messages)").all();
	return tableInfo.some((column) => column.name === "raw_json" || column.name === "processed_json");
};

const migrateLegacyJsonSchema = (db, outputFolder) => {
	if (!isLegacyJsonSchema(db)) {
		return;
	}

	logMessage().db("[DB] Legacy JSON schema detected, migrating to normalized schema");
	const legacyRows = db.prepare("SELECT id, date, raw_json, processed_json, downloaded FROM messages ORDER BY id ASC").all();

	const migrate = db.transaction(() => {
		createMessagesTable(db, "messages_migrated");
		const insertMigrated = db.prepare(`
			INSERT INTO messages_migrated (
				id,
				date,
				message_text,
				is_out,
				sender_id,
				downloaded,
				has_media,
				media_type,
				media_path,
				media_name
			) VALUES (
				@id,
				@date,
				@message_text,
				@is_out,
				@sender_id,
				@downloaded,
				@has_media,
				@media_type,
				@media_path,
				@media_name
			)
		`);

		for (const row of legacyRows) {
			insertMigrated.run(extractRecordFromLegacyRow(row, outputFolder));
		}

		db.exec("DROP TABLE messages");
		db.exec("ALTER TABLE messages_migrated RENAME TO messages");
	});

	migrate();
	createIndexes(db);
	logMessage().db(`[DB] Legacy JSON schema migrated: ${legacyRows.length} rows`);
};

const ensureSchema = (db, outputFolder) => {
	createMessagesTable(db);
	migrateLegacyJsonSchema(db, outputFolder);
	createMessagesTable(db);
	createIndexes(db);
};

const initDatabase = (channelId, outputFolder) => {
	const dbPath = getDbPath(outputFolder);

	logMessage().db(`[DB] initDatabase: channelId=${channelId}, dbPath=${dbPath}`);

	if (dbConnections.has(dbPath)) {
		logMessage().db(`[DB] Reusing existing connection for ${dbPath}`);
		return dbConnections.get(dbPath);
	}

	if (!fs.existsSync(outputFolder)) {
		logMessage().db(`[DB] Creating output directory: ${outputFolder}`);
		fs.mkdirSync(outputFolder, { recursive: true });
	}

	const startTime = Date.now();
	const db = new Database(dbPath);
	const initTime = Date.now() - startTime;
	logMessage().db(`[DB] Database opened in ${initTime}ms: ${dbPath}`);

	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 30000");
	ensureSchema(db, outputFolder);

	dbConnections.set(dbPath, db);
	logMessage().db(`[DB] Connection cached. Total connections: ${dbConnections.size}`);
	return db;
};

const getDatabase = (channelId, outputFolder) => {
	const dbPath = getDbPath(outputFolder);
	const db = dbConnections.get(dbPath) || null;
	logMessage().db(`[DB] getDatabase: channelId=${channelId}, found=${!!db}, path=${dbPath}`);
	return db;
};

const saveMessages = (channelId, outputFolder, rawMessages, processedMessages) => {
	const startTime = Date.now();
	const db = initDatabase(channelId, outputFolder);
	const upsert = getUpsertStatement(db);

	logMessage().db(`[DB] saveMessages: channelId=${channelId}, rawCount=${rawMessages.length}, processedCount=${processedMessages.length}`);

	let savedCount = 0;
	const insertMany = db.transaction((rawBatch, processedBatch) => {
		for (const rawMessage of rawBatch) {
			const record = extractRecordFromRawMessage(rawMessage, outputFolder);
			if (!record) continue;
			upsert.run(record);
			savedCount++;
		}

		for (const processedMessage of processedBatch) {
			const record = extractRecordFromProcessedMessage(processedMessage, outputFolder);
			if (!record) continue;
			upsert.run(record);
			savedCount++;
		}
	});

	insertMany(rawMessages, processedMessages);
	const elapsed = Date.now() - startTime;
	logMessage().db(`[DB] saveMessages complete: saved=${savedCount}, time=${elapsed}ms`);
};

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

const buildProcessedExportObject = (row) => {
	const processed = {
		id: row.id,
		message: row.message_text,
		date: row.date ? new Date(row.date).toISOString() : null,
		out: row.is_out === null || row.is_out === undefined ? undefined : row.is_out === 1,
		sender: row.sender_id,
	};

	if (row.has_media) {
		processed.mediaType = row.media_type || null;
		processed.mediaPath = row.media_path || buildMediaPathFromColumns(row.media_type, row.media_name);
		processed.mediaName = row.media_name || (processed.mediaPath ? path.basename(processed.mediaPath) : null);
		processed.isMedia = true;
	}

	return processed;
};

const buildRawExportObject = (row) => {
	const raw = {
		id: row.id,
		message: row.message_text,
		date: row.date ? new Date(row.date).toISOString() : null,
		out: row.is_out === null || row.is_out === undefined ? undefined : row.is_out === 1,
	};

	if (row.sender_id !== null && row.sender_id !== undefined) {
		raw.fromId = { userId: row.sender_id };
	}

	if (row.has_media) {
		raw.media = {
			type: row.media_type || null,
			path: row.media_path || buildMediaPathFromColumns(row.media_type, row.media_name),
			name: row.media_name || null,
		};
	}

	return raw;
};

function* getMessagesForExport(channelId, outputFolder, type = "all") {
	const db = getDatabase(channelId, outputFolder);
	if (!db) {
		logMessage().db(`[DB] getMessagesForExport: channelId=${channelId}, type=${type}, result=NULL_DB`);
		return;
	}

	logMessage().db(`[DB] getMessagesForExport: channelId=${channelId}, type=${type}, query started`);
	const stmt = db.prepare(`
		SELECT
			id,
			date,
			message_text,
			is_out,
			sender_id,
			has_media,
			media_type,
			media_path,
			media_name
		FROM messages
		ORDER BY id ASC
	`);

	let count = 0;
	for (const row of stmt.iterate()) {
		yield {
			id: row.id,
			date: row.date,
			raw_json: type === "processed" ? null : JSON.stringify(buildRawExportObject(row)),
			processed_json: type === "raw" ? null : JSON.stringify(buildProcessedExportObject(row)),
		};
		count++;
	}

	logMessage().db(`[DB] getMessagesForExport: yielded ${count} rows`);
}

const exportToJsonFiles = (channelId, outputFolder) => {
	const rawFilePath = getRawMessagesPath(outputFolder);
	const processedFilePath = getProcessedMessagesPath(outputFolder);

	logMessage().db(`[DB] exportToJsonFiles: channelId=${channelId}`);

	if (fs.existsSync(rawFilePath)) {
		fs.unlinkSync(rawFilePath);
	}
	if (fs.existsSync(processedFilePath)) {
		fs.unlinkSync(processedFilePath);
	}

	let count = 0;
	const startTime = Date.now();
	for (const row of getMessagesForExport(channelId, outputFolder, "all")) {
		if (row.raw_json) {
			fs.appendFileSync(rawFilePath, row.raw_json + "\n");
		}
		if (row.processed_json) {
			fs.appendFileSync(processedFilePath, row.processed_json + "\n");
		}
		count++;
	}

	const elapsed = Date.now() - startTime;
	logMessage().db(`[DB] exportToJsonFiles: exported ${count} rows in ${elapsed}ms`);
	return count;
};

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
	logMessage().db("[DB] All connections closed");
};

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
	}
};

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
	const updateStmt = db.prepare("UPDATE messages SET downloaded = 1 WHERE id = ?");
	const selectStmt = db.prepare("SELECT id, media_path, media_type, media_name FROM messages WHERE downloaded = 0 AND has_media = 1");
	const rows = selectStmt.all();
	const updateMany = db.transaction(() => {
		for (const row of rows) {
			processedCount++;
			const storedMediaPath = row.media_path || buildMediaPathFromColumns(row.media_type, row.media_name);
			const mediaPathVariants = getStoredMediaPathVariants(storedMediaPath);
			const foundInSnapshots = [...mediaPathVariants].some((storedPath) => snapshotFiles.has(storedPath));
			if (foundInSnapshots) {
				db.prepare("UPDATE messages SET downloaded = 1 WHERE id = ?").run(row.id);
				updatedCount++;
			}
		}
	});

	updateMany();
	const elapsed = Date.now() - startTime;
	logMessage().db(`[DB] syncDownloadedFromSnapshots: processed=${processedCount} rows, updated=${updatedCount}, time=${elapsed}ms`);
	return updatedCount;
};

const getDownloadedSet = (channelId, outputFolder) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) return new Set();

	let rows;
	try {
		rows = db.prepare("SELECT id FROM messages WHERE downloaded = 1").all();
	} catch (e) {
		logMessage().error(`[DB] getDownloadedSet failed: ${e.message}`);
		return new Set();
	}
	return new Set(rows.map((r) => r.id));
};

const getMediaPathMap = (channelId, outputFolder) => {
	const db = getDatabase(channelId, outputFolder);
	if (!db) return new Map();

	const map = new Map();
	try {
		for (const row of db.prepare("SELECT id, media_path, media_type, media_name FROM messages WHERE has_media = 1 AND downloaded = 0").iterate()) {
			const mediaPath = row.media_path || buildMediaPathFromColumns(row.media_type, row.media_name);
			if (mediaPath) {
				const variants = getStoredMediaPathVariants(mediaPath);
				for (const v of variants) {
					map.set(v, row.id);
				}
			}
		}
	} catch (e) {
		logMessage().error(`[DB] getMediaPathMap failed: ${e.message}`);
	}
	return map;
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
	getDownloadedSet,
	getMediaPathMap,
};
