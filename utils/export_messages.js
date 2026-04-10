const path = require("path");
const fs = require("fs");
const { exportToJsonFiles, closeAllConnections } = require("./db");
const paths = require("./paths");
const logger = require("./logger");
const { logMessage } = require("./helper");

const getExportDir = () => process.argv[2]
	? path.resolve(process.argv[2])
	: paths.export;

if (require.main === module) {
	const args = process.argv.slice(2);
	const takeOptionValue = (optionName) => {
		const optionIndex = args.indexOf(optionName);
		if (optionIndex === -1) {
			return undefined;
		}

		const optionValue = args[optionIndex + 1];
		args.splice(optionIndex, optionValue !== undefined ? 2 : 1);
		return optionValue;
	};

	paths.configure({
		root: takeOptionValue("--root"),
		exportDir: takeOptionValue("--export-dir"),
		configFile: takeOptionValue("--config-file"),
		logsDir: takeOptionValue("--logs-dir"),
	});
	process.argv = [process.argv[0], process.argv[1], ...args];
}

/**
 * Получает список всех каналов в директории экспорта
 * @returns {Array<string>} Массив названий каналов
 */
const getChannelList = () => {
	const exportDir = getExportDir();
	if (!fs.existsSync(exportDir)) {
		logMessage.error(`Export directory not found: ${exportDir}`);
		return [];
	}

	const entries = fs.readdirSync(exportDir, { withFileTypes: true });
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
	const exportDir = getExportDir();
	const channelPath = path.join(exportDir, channelId);
	const dbPath = path.join(channelPath, "messages.db");

	// Проверяем существование БД
	if (!fs.existsSync(dbPath)) {
		logMessage.warn(`No database found for channel '${channelId}'. Skipping.`);
		return false;
	}

	logMessage.info(`Exporting messages from channel '${channelId}'...`);

	try {
		const count = exportToJsonFiles(channelId, channelPath);
		logMessage.success(`Successfully exported ${count} messages from '${channelId}' to JSON files.`);
		return true;
	} catch (e) {
		logMessage.error(`Error exporting channel '${channelId}': ${e.message}`);
		return false;
	}
};

/**
 * Основная функция экспорта
 */
	const main = async () => {
	const exportDir = getExportDir();
	logMessage.info("Starting messages export to JSON files...");
	logMessage.info(`Using export directory: ${exportDir}`);

	const channels = getChannelList();

	if (channels.length === 0) {
		logMessage.warn("No channels found in export directory.");
		return 0;
	}

	logMessage.info(`Found ${channels.length} channel(s) to process.`);

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

	logMessage.info(`Export complete. Success: ${successCount}, Failed: ${failCount}`);

	return failCount > 0 ? 1 : 0;
};

// Запускаем экспорт
if (require.main === module) {
	logger.init();
	main()
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
