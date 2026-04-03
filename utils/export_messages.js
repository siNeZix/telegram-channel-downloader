const path = require("path");
const fs = require("fs");
const { exportToJsonFiles, closeAllConnections } = require("./db");

const EXPORT_DIR = path.join(__dirname, "..", "export");

/**
 * Получает список всех каналов в директории экспорта
 * @returns {Array<string>} Массив названий каналов
 */
const getChannelList = () => {
	if (!fs.existsSync(EXPORT_DIR)) {
		console.error(`Export directory not found: ${EXPORT_DIR}`);
		return [];
	}

	const entries = fs.readdirSync(EXPORT_DIR, { withFileTypes: true });
	return entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name);
};

/**
 * Экспортирует сообщения из SQLite БД указанного канала в JSON файлы
 * @param {string} channelId - ID канала
 * @returns {boolean} Успешно ли завершился экспорт
 */
const exportChannel = (channelId) => {
	const channelPath = path.join(EXPORT_DIR, channelId);
	const dbPath = path.join(channelPath, "messages.db");

	// Проверяем существование БД
	if (!fs.existsSync(dbPath)) {
		console.log(`No database found for channel '${channelId}'. Skipping.`);
		return false;
	}

	console.log(`Exporting messages from channel '${channelId}'...`);

	try {
		const count = exportToJsonFiles(channelId, channelPath);
		console.log(`Successfully exported ${count} messages from '${channelId}' to JSON files.`);
		return true;
	} catch (e) {
		console.error(`Error exporting channel '${channelId}':`, e.message);
		return false;
	}
};

/**
 * Основная функция экспорта
 */
const main = async () => {
	console.log("Starting messages export to JSON files...\n");

	const channels = getChannelList();

	if (channels.length === 0) {
		console.log("No channels found in export directory.");
		process.exit(0);
	}

	console.log(`Found ${channels.length} channel(s) to process.\n`);

	let successCount = 0;
	let failCount = 0;

	for (const channelId of channels) {
		const success = exportChannel(channelId);
		if (success) {
			successCount++;
		} else {
			failCount++;
		}
	}

	console.log(`\nExport complete. Success: ${successCount}, Failed: ${failCount}`);

	// Закрываем все соединения с БД
	closeAllConnections();

	process.exit(failCount > 0 ? 1 : 0);
};

// Запускаем экспорт
main();