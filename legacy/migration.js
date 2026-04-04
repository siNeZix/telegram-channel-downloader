const fs = require('fs');
const path = require('path');
const { logMessage } = require('./helper');

/**
 * Конвертирует JSON Array файл в JSON Lines формат
 * @param {string} filePath - путь к JSON файлу
 * @returns {boolean} - успешность конвертации
 */
const convertJsonArrayToJsonLines = (filePath) => {
	try {
		if (!fs.existsSync(filePath)) {
			logMessage.info(`File not found: ${filePath}`);
			return true; // Файла нет, нечего конвертировать
		}
		
		const content = fs.readFileSync(filePath, 'utf8');
		
		// Проверяем, не является ли файл уже JSON Lines
		const lines = content.split('\n').filter(line => line.trim());
		if (lines.length > 1) {
			// Проверяем, является ли каждая строка валидным JSON
			const isJsonLines = lines.every(line => {
				try {
					JSON.parse(line);
					return true;
				} catch {
					return false;
				}
			});
			
			if (isJsonLines) {
				logMessage.info(`File already in JSON Lines format: ${filePath}`);
				return true;
			}
		}
		
		// Парсим как JSON Array
		const jsonArray = JSON.parse(content);
		
		if (!Array.isArray(jsonArray)) {
			logMessage.error(`File is not a JSON Array: ${filePath}`);
			return false;
		}
		
		// Создаем резервную копию
		const backupPath = filePath + '.backup';
		fs.copyFileSync(filePath, backupPath);
		logMessage.info(`Backup created: ${backupPath}`);
		
		// Конвертируем в JSON Lines
		const jsonLines = JSON.stringify(jsonArray) + '\n';
		fs.writeFileSync(filePath, jsonLines);
		
		logMessage.success(`Converted to JSON Lines: ${filePath}`);
		return true;
		
	} catch (e) {
		logMessage.error(`Error converting file ${filePath}: ${e.message}`);
		return false;
	}
};

/**
 * Мигрирует все JSON файлы в директории экспорта
 */
const migrateExportFiles = () => {
	const exportDir = path.join(__dirname, '../export');
	
	if (!fs.existsSync(exportDir)) {
		logMessage.info('Export directory not found');
		return;
	}
	
	const channels = fs.readdirSync(exportDir);
	
	for (const channel of channels) {
		const channelDir = path.join(exportDir, channel);
		
		if (!fs.statSync(channelDir).isDirectory()) {
			continue;
		}
		
		const rawMessagePath = path.join(channelDir, 'raw_message.json');
		const allMessagePath = path.join(channelDir, 'all_message.json');
		
		convertJsonArrayToJsonLines(rawMessagePath);
		convertJsonArrayToJsonLines(allMessagePath);
	}
};

/**
 * Удаляет дубликаты из JSON Lines файла по полю id
 * @param {string} filePath - путь к файлу
 * @returns {boolean} - успешность дедупликации
 */
const deduplicateJSONLinesFile = (filePath) => {
	try {
		if (!fs.existsSync(filePath)) {
			logMessage.info(`File not found: ${filePath}`);
			return true;
		}

		const content = fs.readFileSync(filePath, 'utf8');
		const lines = content.split('\n').filter(line => line.trim());

		if (lines.length === 0) {
			return true;
		}

		// Собираем все id и проверяем на дубликаты
		const seenIds = new Set();
		const uniqueLines = [];
		let duplicateCount = 0;

		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				// Массивы обрабатываем поэлементно
				if (Array.isArray(obj)) {
					for (const item of obj) {
						if (item && typeof item === 'object' && 'id' in item) {
							if (seenIds.has(item.id)) {
								duplicateCount++;
							} else {
								seenIds.add(item.id);
								uniqueLines.push(item);
							}
						} else {
							uniqueLines.push(item);
						}
					}
				} else if (obj && typeof obj === 'object' && 'id' in obj) {
					if (seenIds.has(obj.id)) {
						duplicateCount++;
					} else {
						seenIds.add(obj.id);
						uniqueLines.push(obj);
					}
				} else {
					// Объект без id — сохраняем как есть
					uniqueLines.push(obj);
				}
			} catch (e) {
				logMessage.warn(`Failed to parse line: ${e.message}`);
			}
		}

		if (duplicateCount === 0) {
			logMessage.info(`No duplicates found in ${filePath}`);
			return true;
		}

		logMessage.info(`Found ${duplicateCount} duplicates in ${filePath}`);

		// Создаём резервную копию
		const backupPath = filePath + '.backup';
		fs.copyFileSync(filePath, backupPath);
		logMessage.info(`Backup created: ${backupPath}`);

		// Перезаписываем файл
		const jsonLines = JSON.stringify(uniqueLines) + '\n';
		fs.writeFileSync(filePath, jsonLines);

		logMessage.success(`Deduplicated ${filePath}: ${uniqueLines.length} unique items, ${duplicateCount} duplicates removed`);
		return true;

	} catch (e) {
		logMessage.error(`Error deduplicating file ${filePath}: ${e.message}`);
		return false;
	}
};

/**
 * Очищает дубликаты во всех файлах сообщений для конкретного канала
 * @param {string} channelDir - путь к директории канала
 */
const deduplicateChannelFiles = (channelDir) => {
	if (!fs.existsSync(channelDir) || !fs.statSync(channelDir).isDirectory()) {
		return;
	}

	const rawMessagePath = path.join(channelDir, 'raw_message.json');
	const allMessagePath = path.join(channelDir, 'all_message.json');

	deduplicateJSONLinesFile(rawMessagePath);
	deduplicateJSONLinesFile(allMessagePath);
};

/**
 * Очищает дубликаты во всех каналах экспорта
 */
const deduplicateAllChannels = () => {
	const exportDir = path.join(__dirname, '../export');

	if (!fs.existsSync(exportDir)) {
		logMessage.info('Export directory not found');
		return;
	}

	const channels = fs.readdirSync(exportDir);

	for (const channel of channels) {
		const channelDir = path.join(exportDir, channel);
		deduplicateChannelFiles(channelDir);
	}
};

module.exports = {
	convertJsonArrayToJsonLines,
	migrateExportFiles,
	deduplicateJSONLinesFile,
	deduplicateChannelFiles,
	deduplicateAllChannels,
};
