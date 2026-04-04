/**
 * Скрипт миграции существующих JSON файлов сообщений в SQLite базу данных
 * Запускается командой: npm run migrate-json-to-db
 * 
 * Мигрирует данные из:
 *   - raw_message.json (сырые сообщения от Telegram API)
 *   - all_message.json (обработанные сообщения)
 * 
 * В:
 *   - messages.db (SQLite база данных)
 */

const fs = require("fs");
const path = require("path");
const { initDatabase, saveMessages, closeDatabase, getMessageCount } = require("./db");
const { logMessage } = require("./helper");

const EXPORT_DIR = path.join(__dirname, "..", "export");

/**
 * Читает JSON Lines файл и возвращает массив объектов
 * @param {string} filePath - Путь к файлу
 * @returns {Array} Массив объектов из файла
 */
const readJSONLinesFile = (filePath) => {
	if (!fs.existsSync(filePath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter(line => line.trim());

		const result = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (Array.isArray(parsed)) {
					result.push(...parsed);
				} else {
					result.push(parsed);
				}
			} catch (e) {
				// Пропускаем некорректные строки
			}
		}

		return result;
	} catch (e) {
		logMessage.error(`Error reading file ${filePath}: ${e.message}`);
		return [];
	}
};

/**
 * Мигрирует JSON файлы канала в SQLite
 * @param {string} channelId - ID канала
 * @returns {Object} Результат миграции
 */
const migrateChannel = (channelId) => {
	const channelPath = path.join(EXPORT_DIR, channelId);
	const rawFilePath = path.join(channelPath, "raw_message.json");
	const processedFilePath = path.join(channelPath, "all_message.json");

	// Проверяем наличие JSON файлов
	const rawExists = fs.existsSync(rawFilePath);
	const processedExists = fs.existsSync(processedFilePath);

	if (!rawExists && !processedExists) {
		logMessage.info(`No JSON files found for channel '${channelId}'. Skipping.`);
		return { skipped: true, reason: "no_json_files" };
	}

	// Проверяем, есть ли уже данные в БД
	const existingCount = getMessageCount(channelId, channelPath);
	if (existingCount > 0) {
		logMessage.info(`Channel '${channelId}' already has ${existingCount} messages in DB. Skipping.`);
		return { skipped: true, reason: "already_migrated", existingCount };
	}

	logMessage.info(`Migrating channel '${channelId}'...`);

	// Инициализируем базу данных
	initDatabase(channelId, channelPath);

	try {
		// Читаем сырые сообщения
		const rawMessages = readJSONLinesFile(rawFilePath);
		logMessage.info(`Read ${rawMessages.length} raw messages`);

		// Читаем обработанные сообщения
		const processedMessages = readJSONLinesFile(processedFilePath);
		logMessage.info(`Read ${processedMessages.length} processed messages`);

		// Создаем Map для быстрого поиска обработанных сообщений по ID
		const processedMap = new Map();
		processedMessages.forEach(msg => {
			if (msg && msg.id) {
				processedMap.set(msg.id, msg);
			}
		});

		// Объединяем данные: для каждого сырого сообщения находим обработанное
		const mergedMessages = rawMessages.map(rawMsg => {
			return {
				raw: rawMsg,
				processed: processedMap.get(rawMsg.id) || null
			};
		});

		// Сохраняем в SQLite пачками по 1000 сообщений
		const BATCH_SIZE = 1000;
		let saved = 0;

		for (let i = 0; i < mergedMessages.length; i += BATCH_SIZE) {
			const batch = mergedMessages.slice(i, i + BATCH_SIZE);
			const rawBatch = batch.map(b => b.raw);
			const processedBatch = batch.map(b => b.processed).filter(p => p !== null);

			saveMessages(channelId, channelPath, rawBatch, processedBatch);
			saved += batch.length;

			if (saved % 5000 === 0 || saved === mergedMessages.length) {
				logMessage.info(`Migrated ${saved}/${mergedMessages.length} messages...`);
			}
		}

		// Закрываем соединение с БД
		closeDatabase(channelPath);

		const finalCount = getMessageCount(channelId, channelPath);
		logMessage.success(`Successfully migrated ${finalCount} messages from '${channelId}' to SQLite`);

		return {
			success: true,
			rawCount: rawMessages.length,
			processedCount: processedMessages.length,
			finalDbCount: finalCount
		};
	} catch (e) {
		logMessage.error(`Error migrating channel '${channelId}': ${e.message}`);
		closeDatabase(channelPath);
		return { success: false, error: e.message };
	}
};

/**
 * Получает список каналов с JSON файлами
 */
const getChannelsWithJsonFiles = () => {
	if (!fs.existsSync(EXPORT_DIR)) {
		return [];
	}

	const entries = fs.readdirSync(EXPORT_DIR, { withFileTypes: true });
	return entries
		.filter(entry => entry.isDirectory())
		.filter(entry => {
			const rawPath = path.join(EXPORT_DIR, entry.name, "raw_message.json");
			const processedPath = path.join(EXPORT_DIR, entry.name, "all_message.json");
			return fs.existsSync(rawPath) || fs.existsSync(processedPath);
		})
		.map(entry => entry.name);
};

/**
 * Основная функция миграции
 */
const main = () => {
	logMessage.info("=".repeat(60));
	logMessage.info("Starting JSON to SQLite migration...");
	logMessage.info("=".repeat(60));

	const channels = getChannelsWithJsonFiles();

	if (channels.length === 0) {
		logMessage.info("No channels with JSON files found.");
		process.exit(0);
	}

	logMessage.info(`Found ${channels.length} channel(s) with JSON files to migrate.\n`);

	let successCount = 0;
	let failCount = 0;
	let skippedCount = 0;

	for (const channelId of channels) {
		logMessage.info("-".repeat(40));
		const result = migrateChannel(channelId);

		if (result.success) {
			successCount++;
		} else if (result.skipped) {
			skippedCount++;
		} else {
			failCount++;
		}
	}

	logMessage.info("=".repeat(60));
	logMessage.info("Migration complete!");
	logMessage.info(`  Success: ${successCount}`);
	logMessage.info(`  Skipped: ${skippedCount}`);
	logMessage.info(`  Failed: ${failCount}`);
	logMessage.info("=".repeat(60));

	process.exit(failCount > 0 ? 1 : 0);
};

// Запускаем миграцию
main();