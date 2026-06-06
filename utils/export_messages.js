const path = require("path");
const fs = require("fs");
const { exportToJsonFiles, closeAllConnections } = require("./db");
const paths = require("./paths");
const logger = require("./logger");
const { logMessage } = require("./helper");

/**
 * Получает список всех каналов в директории экспорта
 * @param {string} exportDir
 * @returns {Array<string>} Массив названий каналов
 */
const getChannelList = (exportDir) => {
	if (!fs.existsSync(exportDir)) {
		logMessage.error(`Export directory not found: ${exportDir}`);
		return [];
	}

	const entries = fs.readdirSync(exportDir, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

/**
 * Экспортирует сообщения из SQLite БД указанного канала в JSON файлы
 * @param {string} channelId - ID канала
 * @returns {boolean} Успешно ли завершился экспорт
 */
const exportChannel = async (exportDir, channelId) => {
	const channelPath = path.join(exportDir, channelId);
	const dbPath = path.join(channelPath, "messages.db");

	// Проверяем существование БД
	if (!fs.existsSync(dbPath)) {
		logMessage.warn(`No database found for channel '${channelId}'. Skipping.`);
		return false;
	}

	logMessage.info(`Exporting messages from channel '${channelId}'...`);

	try {
		const count = await exportToJsonFiles(channelId, channelPath);
		logMessage.success(`Successfully exported ${count} messages from '${channelId}' to JSON files.`);
		return true;
	} catch (e) {
		logMessage.error(`Error exporting channel '${channelId}': ${e.message}`);
		return false;
	}
};

/**
 * Основная функция экспорта
 * @param {string} [exportDir]
 */
const main = async (exportDir = paths.export) => {
	logMessage.info("Starting messages export to JSON files...");
	logMessage.info(`Using export directory: ${exportDir}`);

	const channels = getChannelList(exportDir);

	if (channels.length === 0) {
		logMessage.warn("No channels found in export directory.");
		return 0;
	}

	logMessage.info(`Found ${channels.length} channel(s) to process.`);

	let successCount = 0;
	let failCount = 0;

	for (const channelId of channels) {
		const success = await exportChannel(exportDir, channelId);
		if (success) {
			successCount++;
		} else {
			failCount++;
		}
	}

	logMessage.info(`Export complete. Success: ${successCount}, Failed: ${failCount}`);

	return failCount > 0 ? 1 : 0;
};

// Запускаем экспорт
if (require.main === module) {
	const { parseRuntimeOptions, resolveExportDir } = require("./cli_utils");
	const args = process.argv.slice(2);
	parseRuntimeOptions(args);
	const exportDir = resolveExportDir(args[0]);

	logger.init();
	main(exportDir)
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((err) => {
			logger.writeSync("error", `[EXPORT] Unhandled export error: ${err?.stack || err?.message || String(err)}`);
			console.error(err);
			process.exitCode = 1;
		})
		.finally(() => {
			closeAllConnections();
			logger.close();
		});
}

module.exports = {
	main,
};
