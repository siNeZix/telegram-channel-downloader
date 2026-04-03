const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// Структура для хранения открытых соединений с БД для каждого канала
const dbConnections = new Map();

/**
 * Инициализирует базу данных SQLite для указанного канала
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @returns {Database.Database} Объект базы данных
 */
const initDatabase = (channelId, outputFolder) => {
	const dbPath = path.join(outputFolder, "messages.db");
	
	// Проверяем, есть ли уже открытое соединение
	if (dbConnections.has(dbPath)) {
		return dbConnections.get(dbPath);
	}
	
	// Создаем директорию, если не существует
	if (!fs.existsSync(outputFolder)) {
		fs.mkdirSync(outputFolder, { recursive: true });
	}
	
	// Открываем/создаем базу данных
	const db = new Database(dbPath);
	
	// Включаем WAL режим для лучшей производительности
	db.pragma("journal_mode = WAL");
	
	// Создаем таблицу, если не существует
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER NOT NULL,
			date INTEGER,
			raw_json TEXT,
			processed_json TEXT,
			PRIMARY KEY (id)
		)
	`);
	
	// Создаем индекс для быстрой сортировки по дате
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)
	`);
	
	// Сохраняем соединение в кэш
	dbConnections.set(dbPath, db);
	
	return db;
};

/**
 * Получает объект базы данных для указанного канала
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @returns {Database.Database|null} Объект базы данных или null
 */
const getDatabase = (channelId, outputFolder) => {
	const dbPath = path.join(outputFolder, "messages.db");
	return dbConnections.get(dbPath) || null;
};

/**
 * Сохраняет пачку сообщений в базу данных
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 * @param {Array} rawMessages - Массив сырых сообщений от Telegram API
 * @param {Array} processedMessages - Массив обработанных сообщений (упрощенный формат)
 */
const saveMessages = (channelId, outputFolder, rawMessages, processedMessages) => {
	const db = initDatabase(channelId, outputFolder);
	
	// Используем транзакцию для атомарной вставки
	const insertRaw = db.prepare(`
		INSERT OR REPLACE INTO messages (id, date, raw_json, processed_json)
		VALUES (?, ?, ?, ?)
	`);
	
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
			
			insertRaw.run(
				rawMsg.id,
				dateTimestamp,
				JSON.stringify(rawMsg),
				processedMsg ? JSON.stringify(processedMsg) : null
			);
		}
	});
	
	insertMany(rawMessages, processedMessages);
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
	if (!db) return false;
	
	const result = db.prepare("SELECT 1 FROM messages WHERE id = ?").get(messageId);
	return !!result;
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
	
	const result = db.prepare("SELECT COUNT(*) as count FROM messages").get();
	return result ? result.count : 0;
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
	if (!db) return;
	
	const query = type === "raw" 
		? "SELECT id, date, raw_json FROM messages ORDER BY id ASC"
		: type === "processed"
			? "SELECT id, date, processed_json FROM messages ORDER BY id ASC"
			: "SELECT id, date, raw_json, processed_json FROM messages ORDER BY id ASC";
	
	const stmt = db.prepare(query);
	
	for (const row of stmt.iterate()) {
		yield row;
	}
}

/**
 * Экспортирует данные из SQLite обратно в JSON Lines формат
 * @param {string} channelId - ID канала
 * @param {string} outputFolder - Путь к папке экспорта
 */
const exportToJsonFiles = (channelId, outputFolder) => {
	const rawFilePath = path.join(outputFolder, "raw_message.json");
	const processedFilePath = path.join(outputFolder, "all_message.json");
	
	// Очищаем существующие файлы
	if (fs.existsSync(rawFilePath)) {
		fs.unlinkSync(rawFilePath);
	}
	if (fs.existsSync(processedFilePath)) {
		fs.unlinkSync(processedFilePath);
	}
	
	let count = 0;
	
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
	
	return count;
};

/**
 * Закрывает все открытые соединения с базой данных
 */
const closeAllConnections = () => {
	for (const [dbPath, db] of dbConnections) {
		try {
			db.close();
		} catch (e) {
			console.error(`Error closing database ${dbPath}:`, e.message);
		}
	}
	dbConnections.clear();
};

/**
 * Закрывает соединение с базой данных для указанного канала
 * @param {string} outputFolder - Путь к папке экспорта
 */
const closeDatabase = (outputFolder) => {
	const dbPath = path.join(outputFolder, "messages.db");
	if (dbConnections.has(dbPath)) {
		try {
			dbConnections.get(dbPath).close();
			dbConnections.delete(dbPath);
		} catch (e) {
			console.error(`Error closing database ${dbPath}:`, e.message);
		}
	}
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
};