const fs = require("fs");
const path = require("path");
const config = require("../utils/config");
const {
	getMediaType,
	logMessage,
	wait,
	checkFileExist,
	getMediaPath,
	getMediaRelativePath,
	clearFileCheckCache,
	addFileToCheckCache,
	initDownloadState,
	buildFileName,
	filterString,
	fileCheckCache,
	loadSnapshots,
	downloadState,
} = require("../utils/helper");
const {
	getLastSelection,
	updateLastSelection,
} = require("../utils/file_helper");
const db = require("../utils/db");
const { circularStringify } = require("../utils/helper");
const paths = require("../utils/paths");
const { MessageService } = require("../services/MessageService");
const { DownloadManager } = require("../services/DownloadManager");
const { TelegramEntityResolver } = require("../services/TelegramEntityResolver");
const { createFloodState } = require("../services/FloodControl");
const { ProgressLogger, PROGRESS_LOG_INTERVAL_SECONDS } = require("../services/ProgressLogger");
const { isFFmpegAvailable, getFFmpegPaths, validateFile } = require("../validators");

// Флаг для будущих текстовых фильтров. Сейчас они отключены,
// но логика оставлена в коде и может быть легко включена.
const ENABLE_TEXT_FILTERS = false;
const MAX_RPC_RETRIES = 5;
const CHECK_PROGRESS_INTERVAL_MS = 5000;

const resolveOutputFolder = (channelId, options = {}) =>
	options.outputFolder || paths.getChannelExportPath(channelId, options.exportPath);

const getEntityResolver = (client) => {
	if (!client.__tgdlEntityResolver) {
		client.__tgdlEntityResolver = new TelegramEntityResolver(client);
	}
	return client.__tgdlEntityResolver;
};

// Логирование прогресса проверки файлов
const logCheckProgress = (checked, total, skipped, newFiles, startedAt) => {
	const percent = total > 0 ? Math.round((checked * 100) / total) : 100;
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	const timestamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
	logMessage.info(
		`[${timestamp}] [CHECK] Progress: ${checked}/${total} (${percent}%), skipped: ${skipped}, new: ${newFiles}, elapsed: ${elapsed}s`,
	);
};

const getLastKnownOffsetId = () => Number(getLastSelection().messageOffsetId || 0);

const formatEta = (totalSeconds) => {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
		return "unknown";
	}
	const seconds = Math.max(0, Math.round(totalSeconds));
	const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
	const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
	const ss = String(seconds % 60).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
};

const formatBytes = (bytes) => {
	if (bytes === 0) return "0 MB";
	const mb = bytes / (1024 * 1024);
	if (mb >= 1000) {
		return `${(mb / 1024).toFixed(2)} GB`;
	}
	return `${mb.toFixed(2)} MB`;
};

const logDownloadProgress = (
	startedAt,
	totalFiles,
	success,
	failed,
	speedHistory,
	totalBytesDownloaded,
	activeDownloads = 0,
	maxParallel = config.get('download.maxParallel'),
) => {
	const finished = success + failed;
	const percent =
		totalFiles > 0 ? Math.round((finished * 100) / totalFiles) : 100;

	// Средняя скорость за всё время
	const elapsedSec = (Date.now() - startedAt) / 1000;
	const overallRate = elapsedSec > 0 ? finished / elapsedSec : 0;

	// Средняя скорость за последние 10 секунд (в МБ/с)
	const now = Date.now();
	const tenSecondsAgo = now - 10000;

	// Удаляем старые записи
	while (
		speedHistory.length > 0 &&
		speedHistory[0].timestamp < tenSecondsAgo
	) {
		speedHistory.shift();
	}

	// Добавляем текущую точку
	speedHistory.push({
		timestamp: now,
		completed: finished,
		bytes: totalBytesDownloaded,
	});

	// Рассчитываем скорость за последние 10 секунд
	let recentRate = 0; // файлов/с
	let recentBytesRate = 0; // байт/с
	if (speedHistory.length >= 2) {
		const firstPoint = speedHistory[0];
		const lastPoint = speedHistory[speedHistory.length - 1];
		const timeDiff = (lastPoint.timestamp - firstPoint.timestamp) / 1000;
		if (timeDiff > 0) {
			recentRate =
				(lastPoint.completed - firstPoint.completed) / timeDiff;
			recentBytesRate = (lastPoint.bytes - firstPoint.bytes) / timeDiff;
		}
	}

	const remaining = Math.max(0, totalFiles - finished);
	const eta =
		recentRate > 0
			? formatEta(remaining / recentRate)
			: overallRate > 0
				? formatEta(remaining / overallRate)
				: "unknown";

	const speedMBs = recentBytesRate / (1024 * 1024);
	const speedText =
		speedHistory.length >= 2
			? `${speedMBs.toFixed(2)} MB/s (avg 10s)`
			: `${(totalBytesDownloaded / (1024 * 1024) / Math.max(elapsedSec, 1)).toFixed(2)} MB/s (overall)`;

	// Добавляем временную метку и состояние очереди
	const timestamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
	logMessage.info(
		`[${timestamp}] [DL] Progress: ${finished}/${totalFiles} (${percent}%), failed: ${failed}, speed: ${speedText}, downloaded: ${formatBytes(totalBytesDownloaded)}, ETA: ${eta}, queue: ${activeDownloads}/${maxParallel}`,
	);
};

const getErrorText = (err) =>
	(err?.errorMessage || err?.message || String(err) || "").toUpperCase();

const parseFloodWaitSeconds = (err) => {
	const directSeconds = Number(err?.seconds);
	if (Number.isFinite(directSeconds) && directSeconds > 0) {
		return directSeconds;
	}
	const text = getErrorText(err);
	const floodMatch = text.match(/FLOOD_WAIT_?(\d+)/);
	if (floodMatch?.[1]) {
		return Number(floodMatch[1]);
	}
	const waitMatch = text.match(/A WAIT OF (\d+) SECONDS/);
	if (waitMatch?.[1]) {
		return Number(waitMatch[1]);
	}
	return null;
};

const maybeWaitCooldown = async (state) => {
	const now = Date.now();
	if (state.cooldownUntil > now) {
		const remainingSeconds = Math.ceil((state.cooldownUntil - now) / 1000);
		logMessage.flood(`Cooldown active: waiting ${remainingSeconds}s before next API call`);
		await wait(remainingSeconds);
	}
};

const runWithFloodControl = async (state, label, fn) => {
	for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
		await maybeWaitCooldown(state);
		const baseDelay = config.get('download.baseRpcDelaySeconds');
		if (baseDelay > 0) {
			await wait(baseDelay);
		}
		try {
			const result = await fn();
			state.successStreak += 1;
			if (
				state.successStreak >= 30 &&
				state.currentParallelLimit < config.get('download.maxParallel')
			) {
				state.currentParallelLimit += 1;
				state.successStreak = 0;
				logMessage.flood(`Increased parallel limit to ${state.currentParallelLimit} (successStreak=30)`);
			}
			return result;
		} catch (err) {
			const floodSeconds = parseFloodWaitSeconds(err);
			if (floodSeconds) {
				state.consecutiveFloods += 1;
				state.successStreak = 0;
				state.currentParallelLimit = Math.max(
					config.get('download.minParallel'),
					state.currentParallelLimit - 1,
				);
				state.cooldownUntil = Date.now() + (floodSeconds + 1) * 1000;
				logMessage.error(
					`[FLOOD] Detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit now ${state.currentParallelLimit}`,
				);
				logMessage.flood(`Flood details: label=${label}, attempt=${attempt}, floodSeconds=${floodSeconds}, cooldownUntil=${state.cooldownUntil}, consecutiveFloods=${state.consecutiveFloods}`);
				// Не ждём здесь - maybeWaitCooldown в следующей итерации сам подождёт
				continue;
			}
			throw err;
		}
	}
	throw new Error(
		`Exceeded retry limit (${MAX_RPC_RETRIES}) for ${label} due to flood protection`,
	);
};

const downloadMessageMedia = async (client, message, mediaPath, floodState, channelId, outputFolder) => {
	const msgId = message?.id;
	const mediaType = message?.media ? getMediaType(message) : "none";
	logMessage.dl(`Starting download: msgId=${msgId}, type=${mediaType}, path=${mediaPath}`);
	
	try {
		if (message.media) {
			if (message.media.webpage) {
				let url = message.media.webpage.url;
				if (url) {
					let urlPath = path.join(
						mediaPath,
						`../${message.id}_url.txt`,
					);
					logMessage.dl(`Saving webpage URL for msgId=${msgId}: ${url}`);
					fs.writeFileSync(urlPath, url);
				}

				mediaPath = path.join(
					mediaPath,
					`../${message?.media?.webpage?.id}_image.jpeg`,
				);
			}

			if (message.media.poll) {
				let pollPath = path.join(
					mediaPath,
					`../${message.id}_poll.json`,
				);
				logMessage.dl(`Saving poll data for msgId=${msgId}`);
				fs.writeFileSync(
					pollPath,
					circularStringify(message.media.poll, null, 2),
				);
			}

			let fileSize = 0;
			await runWithFloodControl(floodState, `downloadMedia-msg${msgId}`, async () => {
				return client.downloadMedia(message, {
					outputFile: mediaPath,
					progressCallback: (downloaded, total) => {
						fileSize = downloaded;
						const name = path.basename(mediaPath);
						if (total == downloaded) {
							logMessage.dl(`Download complete: msgId=${msgId}, file=${name}, size=${fileSize}`);
						}
					},
				});
			});

			// Если fileSize не обновился, получаем размер файла из файловой системы
			if (fileSize === 0 && fs.existsSync(mediaPath)) {
				fileSize = fs.statSync(mediaPath).size;
				logMessage.dl(`File size from fs: msgId=${msgId}, size=${fileSize}`);
			}

			// Отмечаем файл как скачанный в БД
			if (channelId && outputFolder) {
				db.setFileDownloaded(channelId, outputFolder, message.id, 1);
				downloadState.markDownloaded(message.id);
				logMessage.dl(`Marked as downloaded in DB: msgId=${msgId}, channelId=${channelId}`);
			}

			return { success: true, fileSize };
		} else {
			logMessage.dl(`No media in message: msgId=${msgId}`);
			return { success: false, fileSize: 0 };
		}
	} catch (err) {
		logMessage.error(
			`[DL] Error in downloadMessageMedia: msgId=${msgId}, error=${err?.message || String(err)}`,
		);
		return { success: false, fileSize: 0 };
	}
};

const getMessages = async (client, channelId, downloadableFiles = {}, options = {}) => {
	const { check: enableCheck = false, deep: deepValidation = false } = options;
	const lastKnownOffsetId = getLastKnownOffsetId();

	logMessage.fetch(`=== Starting getMessages: channelId=${channelId}, check=${enableCheck}, deep=${deepValidation} ===`);
	logMessage.fetch(`Config: messageLimit=${config.get('download.messageLimit')}, fastForwardMessageLimit=${config.get('download.fastForwardMessageLimit')}, lastKnownOffsetId=${lastKnownOffsetId}`);

	// Initialize FFmpeg for validation if needed
	let ffmpegPaths = null;
	if (enableCheck) {
		const ffmpegAvailable = await isFFmpegAvailable();
		if (!ffmpegAvailable) {
			logMessage.warn(`[VALID] ffmpeg not found, skipping file validation`);
		} else {
			ffmpegPaths = await getFFmpegPaths();
			if (deepValidation) {
				logMessage.info(`[VALID] File validation: ENABLED (DEEP mode - full decode)`);
			} else {
				logMessage.info(`[VALID] File validation: ENABLED (FAST mode - headers only)`);
			}
		}
	}
	
	try {
		const floodState = createFloodState();
		logMessage.fetch(`FloodControl state initialized: maxParallel=${floodState.currentParallelLimit}`);
		
		let offsetId = 0;
		let fastForwardMode = Number(lastKnownOffsetId) > 0;
		logMessage.fetch(`FastForward mode: ${fastForwardMode} (lastKnownOffsetId=${lastKnownOffsetId})`);
		
		// Инициализация outputFolder может выбросить исключение
		// поэтому оборачиваем в отдельный try для возможности закрыть БД в catch
		let outputFolder;
		try {
			outputFolder = resolveOutputFolder(channelId, options);
			logMessage.fetch(`Output folder: ${outputFolder}`);
		} catch (folderErr) {
			logMessage.error(`[FETCH] Failed to initialize output folder: ${folderErr?.message || String(folderErr)}`);
			throw folderErr;
		}
		
		let rawMessagePath = path.join(outputFolder, "raw_message.json");
		let messageFilePath = path.join(outputFolder, "all_message.json");
		let totalFetched = 0;
		let totalMessagesInChannel = 0; // Общее количество сообщений в канале
		let totalFilesToDownload = 0; // Общее количество файлов для скачивания (оценка)
		let actualFilesFound = 0; // Фактически найденные файлы для скачивания
		let queuedDownloads = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		let skippedExisting = 0;
		let skippedByType = 0;
		let skippedByTextFilter = 0;
		let totalBytesDownloaded = 0; // Общее количество скачанных байт
		const downloadStartedAt = Date.now();
		let lastProgressLogAt = 0;
		const speedHistory = []; // История для расчёта скорости за последние 10 секунд

		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder, { recursive: true });
			logMessage.fetch(`Created output folder: ${outputFolder}`);
		}

		// Инициализируем SQLite базу данных для этого канала
		logMessage.db(`Initializing database for channel: ${channelId}`);
		db.initDatabase(channelId, outputFolder);
		logMessage.db(`Database initialized successfully`);

		// Preload all downloaded IDs and media paths from DB into memory
		initDownloadState(channelId, outputFolder);

		// Синхронизируем статус downloaded из снапшотов для уже существующих файлов
		const snapshotFiles = loadSnapshots(outputFolder);
		logMessage.cache(`Loaded ${snapshotFiles.size} files from snapshots`);
		if (snapshotFiles.size > 0) {
			const syncedCount = db.syncDownloadedFromSnapshots(channelId, outputFolder, snapshotFiles);
			if (syncedCount > 0) {
				logMessage.info(`[DB] Synced ${syncedCount} existing files from snapshots as downloaded`);
				initDownloadState(channelId, outputFolder);
			}
		}

		// Set для отслеживания уже записанных ID (предотвращение дубликатов в сессии)
		const knownMessageIds = new Set();

		// Очередь загрузок теперь живет на протяжении всего процесса
		let activeDownloads = new Set();

		while (true) {
			const inFastForwardRange =
				fastForwardMode &&
				(offsetId === 0 || offsetId > Number(lastKnownOffsetId));
			const messageLimit = inFastForwardRange
				? config.get('download.fastForwardMessageLimit')
				: config.get('download.messageLimit');
			
			logMessage.fetch(`Batch loop: offsetId=${offsetId}, fastForwardMode=${fastForwardMode}, inFastForwardRange=${inFastForwardRange}, messageLimit=${messageLimit}, lastKnownOffsetId=${lastKnownOffsetId}`);
			
			if (fastForwardMode && !inFastForwardRange) {
				logMessage.info(
					`[FETCH] Reached last known position (${lastKnownOffsetId}). Switching to normal batch size ${config.get('download.messageLimit')}`,
				);
				fastForwardMode = false;
			}

			let allMessages = [];
			logMessage.fetch(`Fetching next batch: limit=${messageLimit}, offset=${offsetId}`);
			let messages = await runWithFloodControl(
				floodState,
				"getMessages",
			async () => {
				// Проверяем что client инициализирован корректно
				if (!client) {
					throw new Error('Client is not initialized (null/undefined)');
				}
				if (typeof client.getMessages !== 'function') {
					throw new Error(`Client is not properly initialized: getMessages is ${typeof client.getMessages}`);
				}
				const inputPeer = await getEntityResolver(client).resolve(channelId);
				return client.getMessages(inputPeer, {
					limit: messageLimit,
					offsetId: offsetId,
				});
			},
			);
			logMessage.fetch(`Fetched ${messages.length} messages (total so far: ${totalFetched + messages.length})`);
			totalFetched += messages.length;

			// Получаем общее количество сообщений в канале из первого ответа
			if (totalMessagesInChannel === 0 && messages.total > 0) {
				totalMessagesInChannel = messages.total;
				logMessage.fetch(`Total messages in channel: ${totalMessagesInChannel}`);
			}

			// Сохраняем сырые сообщения в SQLite для оптимизации (вместо JSON файлов)
			logMessage.db(`Saving ${messages.length} raw messages to database`);
			db.saveMessages(channelId, outputFolder, messages, []);
			
			logMessage.fetch(`Processed messages: ${totalFetched}/${messages.total} = ${Math.round((totalFetched * 100) / messages.total)}%`);
			
			const beforeFilter = messages.length;
			messages = messages.filter(
				(message) =>
					message.message != undefined || message.media != undefined,
			);
			logMessage.filter(`Message filter: ${messages.length} remain after filtering (filtered out ${beforeFilter - messages.length} empty messages)`);
			
			messages.forEach((message) => {
				// Пропускаем дубликаты в текущей сессии
				if (knownMessageIds.has(message.id)) {
					return;
				}
				knownMessageIds.add(message.id);

				let obj = {
					id: message.id,
					message: message.message,
					date: message.date,
					out: message.out,
					sender: message.fromId?.userId || message.peerId?.userId,
				};
				if (message.media) {
					const mediaPath = getMediaPath(message, outputFolder);
					const fileName = path.basename(mediaPath);
					obj.mediaType = message.media
						? getMediaType(message)
						: null;
					obj.mediaPath = getMediaRelativePath(message);
					obj.mediaName = fileName;
					obj.isMedia = true;
				}

				allMessages.push(obj);
			});

			if (messages.length === 0) {
				logMessage.success(
					`[FETCH] Done with all messages (${totalFetched}) 100%`,
				);
				// В конце использу фактическое количество
				totalFilesToDownload = actualFilesFound;
				break;
			}

			// Подсчитываем файлы для скачивания в текущей пачке и проверяем существование
			let batchFilesToDownload = 0;
			let batchSkippedExisting = 0;
			let batchNewFiles = 0;
			const checkStartedAt = Date.now();
			let lastCheckProgressLogAt = 0;
			let checkedFiles = 0;
			
			// Debug: Track timing for validation vs other operations
			let validationCount = 0;
			let validationTotalMs = 0;
			let checkExistTotalMs = 0;
			const checkExistStart = Date.now();

			logMessage.fetch(`Checking ${messages.length} messages for media files`);
			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.media) {
					const mediaType = getMediaType(message);
					const mediaPath = getMediaPath(message, outputFolder);
					const mediaExtension = path
						.extname(mediaPath)
						?.toLowerCase()
						?.replace(".", "");
					const shouldDownload =
						downloadableFiles[mediaType] ||
						downloadableFiles[mediaExtension] ||
						downloadableFiles["all"];
						
					if (!shouldDownload) {
						logMessage.filter(`Skip by type: msgId=${message.id}, type=${mediaType}, ext=${mediaExtension}`);
						skippedByType++;
						continue;
					}
					
					// Проверяем существование файла и кэшируем результат
					const fileExistStart = Date.now();
					let fileExist = checkFileExist(message, outputFolder, channelId);
					const fileExistEnd = Date.now();
					checkExistTotalMs += (fileExistEnd - fileExistStart);
					message._checkTimeMs = fileExistEnd - fileExistStart;
					
					// Validation: if file exists and check is enabled, validate it
					// Skip validation for files from snapshots - they are already verified
					if (fileExist && enableCheck && ffmpegPaths && !message._fromSnapshot) {
						const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
						const validationStart = Date.now();
						if (deepValidation) {
							logMessage.valid(`Deep checking: ${path.basename(mediaPath)}`);
						}
						const validationResult = await validateFile(
							mediaPath,
							fileType,
							ffmpegPaths.ffmpeg,
							ffmpegPaths.ffprobe,
							deepValidation // true for deep, false for fast
						);
						const validationEnd = Date.now();
						const validationMs = validationEnd - validationStart;
						validationCount++;
						validationTotalMs += validationMs;
						message._validationMs = validationMs;
						
						if (validationMs > 100) {
							logMessage.valid(`[TIMING] Slow validation: ${path.basename(mediaPath)} took ${validationMs}ms`);
						}
		
						if (!validationResult.valid) {
							logMessage.warn(`[VALID] File failed validation: ${path.basename(mediaPath)} - ${validationResult.error}`);
							logMessage.info(`[VALID] Will re-download: ${path.basename(mediaPath)}`);
							fileExist = false;
							// Remove invalid file so it can be re-downloaded
							try {
								if (fs.existsSync(mediaPath)) {
									fs.unlinkSync(mediaPath);
									logMessage.valid(`Deleted invalid file: ${mediaPath}`);
								}
							} catch (e) {
								logMessage.error(`[VALID] Failed to delete invalid file: ${e.message}`);
							}
							// Clear from cache so it's not used
							fileCheckCache.delete(mediaPath);
						}
					}
	
					message._fileExist = fileExist; // Кэшируем для последующего использования
					checkedFiles += 1;
	
					// Логирование прогресса проверки
					const shouldLogCheck =
						checkedFiles % config.get('download.checkProgressIntervalFiles') === 0 ||
						Date.now() - lastCheckProgressLogAt >= CHECK_PROGRESS_INTERVAL_MS;
					if (shouldLogCheck) {
						logCheckProgress(
							checkedFiles,
							messages.filter(m => m.media).length,
							batchSkippedExisting,
							batchNewFiles,
							checkStartedAt,
						);
						lastCheckProgressLogAt = Date.now();
					}
	
					if (fileExist) {
						batchSkippedExisting += 1;
						logMessage.cache(`Cache hit: ${path.basename(mediaPath)} (skipped)`);
					} else {
						batchNewFiles += 1;
						batchFilesToDownload += 1;
						logMessage.dl(`Need download: msgId=${message.id}, type=${mediaType}, file=${path.basename(mediaPath)}`);
					}
				}
			}

			// Debug: Финальный лог статистики времени проверки
			if (checkedFiles > 0) {
				const checkTotalMs = Date.now() - checkStartedAt;
				const avgValidationMs = validationCount > 0 ? Math.round(validationTotalMs / validationCount) : 0;
				logMessage.fetch(
					`[TIMING] Batch check summary: ${checkedFiles} files in ${checkTotalMs}ms. ` +
					`Validations: ${validationCount} (avg ${avgValidationMs}ms, total ${validationTotalMs}ms). ` +
					`Existence checks: ${checkExistTotalMs}ms. ` +
					`Skipped: ${batchSkippedExisting}, New: ${batchNewFiles}`
				);
			}
			
			// Финальный лог прогресса проверки
			if (checkedFiles > 0) {
				logCheckProgress(
					checkedFiles,
					messages.filter(m => m.media).length,
					batchSkippedExisting,
					batchNewFiles,
					checkStartedAt,
				);
			}

			// Обновляем фактическое количество найденных файлов (включая пропущенные)
			actualFilesFound += batchFilesToDownload + batchSkippedExisting;

			// Оцениваем общее количество файлов пропорционально
			// Используем консервативную оценку: требуем минимум 5% сообщений для экстраполяции
			// Это предотвращает завышение оценки на основе "горячей" начальной части канала
			if (totalMessagesInChannel > 0 && totalFetched > 0) {
				const progress = totalFetched / totalMessagesInChannel;
				if (progress > 0.05) {
					// Минимум 5% сообщений для надёжной оценки
					const estimatedTotal = Math.round(
						actualFilesFound / progress,
					);
					// Не даём оценке уменьшаться, но ограничиваем сверху разумным максимумом
					totalFilesToDownload = Math.min(
						Math.max(totalFilesToDownload, estimatedTotal),
						actualFilesFound +
							Math.ceil((totalMessagesInChannel - totalFetched) * 0.5), // Не более 50% медиа в оставшихся
					);
					logMessage.fetch(`Estimate updated: found=${actualFilesFound}, estimatedTotal=${totalFilesToDownload}, progress=${(progress * 100).toFixed(1)}%`);
				} else {
					// При малом количестве сканированных сообщений используем фактическое число
					// Это предотвращает экстраполяцию на основе первых "горячих" сообщений
					totalFilesToDownload = Math.max(
						totalFilesToDownload,
						actualFilesFound,
					);
					logMessage.fetch(`Estimate (early stage): using actual count=${actualFilesFound}`);
				}
			} else {
				totalFilesToDownload = actualFilesFound;
			}

			// Логируем оценку каждые 500 сообщений
			if (totalFetched % 500 < config.get('download.messageLimit')) {
				// Добавляем информацию о проценте медиа для наглядности
				const mediaPercent =
					totalFetched > 0
						? ((actualFilesFound / totalFetched) * 100).toFixed(1)
						: 0;
				logMessage.info(
					`[ESTIMATE] Files: found=${actualFilesFound}, estimated=${totalFilesToDownload}, scanned=${totalFetched}/${totalMessagesInChannel}, mediaRate=${mediaPercent}%`,
				);
			}

			logMessage.fetch(`Starting download phase for batch: ${batchFilesToDownload} new files`);
			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.media) {
					const mediaType = getMediaType(message);
					const mediaPath = getMediaPath(message, outputFolder);
					// Используем кэшированный результат проверки вместо повторного вызова
					const fileExist = message._fileExist !== undefined
						? message._fileExist
						: checkFileExist(message, outputFolder, channelId);

					const mediaExtension = path
						.extname(mediaPath)
						?.toLowerCase()
						?.replace(".", "");

					const exclude = [
						/прямойэфир/,
						/рыночныйфон/,
						/ситуация по рынку/,
					];
					const include = [/обуч/, /образ/];

					let textMatchesFilters = true;
					if (ENABLE_TEXT_FILTERS) {
						const text = (message.message || "").toLowerCase();
						const isExcluded =
							exclude.findIndex((r) => r.test(text)) !== -1;
						const isIncluded =
							include.findIndex((r) => r.test(text)) !== -1;
						// если текст попал под exclude и при этом не попал под include — не скачиваем
						textMatchesFilters = !(isExcluded && !isIncluded);
						logMessage.filter(`Text filter: msgId=${message.id}, isExcluded=${isExcluded}, isIncluded=${isIncluded}, matches=${textMatchesFilters}`);
					}

					const shouldDownload =
						downloadableFiles[mediaType] ||
						downloadableFiles[mediaExtension] ||
						downloadableFiles["all"];

					logMessage.filter(`Download decision: msgId=${message.id}, type=${mediaType}, ext=${mediaExtension}, shouldDownload=${shouldDownload}, fileExist=${fileExist}, textMatches=${textMatchesFilters}`);

					if (shouldDownload && !fileExist && textMatchesFilters) {
						await wait(0.2);
						logMessage.dl(`Queueing download: msgId=${message.id}, file=${path.basename(mediaPath)}`);
						queuedDownloads += 1;
						let downloadPromise;
						downloadPromise = downloadMessageMedia(
							client,
							message,
							mediaPath,
							floodState,
							channelId,
							outputFolder,
						)
							.then((result) => {
								if (result.success) {
									successfulDownloads += 1;
									totalBytesDownloaded += result.fileSize;
									// Добавляем скачанный файл в кэш проверки
									addFileToCheckCache(mediaPath, result.fileSize);
									logMessage.dl(`Download success: msgId=${message.id}, totalSuccess=${successfulDownloads}, totalBytes=${formatBytes(totalBytesDownloaded)}`);
								} else {
									failedDownloads += 1;
									logMessage.dl(`Download failed: msgId=${message.id}, totalFailed=${failedDownloads}`);
								}
								const now = Date.now();
								const finished =
									successfulDownloads + failedDownloads;
								const shouldLogProgress =
									finished === queuedDownloads ||
									now - lastProgressLogAt >=
										PROGRESS_LOG_INTERVAL_SECONDS * 1000;
								if (shouldLogProgress) {
									logDownloadProgress(
										downloadStartedAt,
										totalFilesToDownload,
										successfulDownloads,
										failedDownloads,
										speedHistory,
										totalBytesDownloaded,
										activeDownloads.size,
										floodState.currentParallelLimit,
									);
									lastProgressLogAt = now;
								}
							})
							.catch(() => {
								failedDownloads += 1;
								logMessage.error(`[DL] Unhandled rejection for msgId=${message.id}`);
								const now = Date.now();
								const finished =
									successfulDownloads + failedDownloads;
								const shouldLogProgress =
									finished === queuedDownloads ||
									now - lastProgressLogAt >=
										PROGRESS_LOG_INTERVAL_SECONDS * 1000;
								if (shouldLogProgress) {
									logDownloadProgress(
										downloadStartedAt,
										totalFilesToDownload,
										successfulDownloads,
										failedDownloads,
										speedHistory,
										totalBytesDownloaded,
										activeDownloads.size,
										floodState.currentParallelLimit,
									);
									lastProgressLogAt = now;
								}
							})
							.finally(() => {
								activeDownloads.delete(downloadPromise);
							});
						activeDownloads.add(downloadPromise);
					} else {
						if (fileExist) {
							skippedExisting += 1;
						} else if (!textMatchesFilters) {
							skippedByTextFilter += 1;
						} else {
							skippedByType += 1;
						}
					}

					if (
						activeDownloads.size >= floodState.currentParallelLimit
					) {
						logMessage.dl(
							`Download queue is full (${floodState.currentParallelLimit}). Waiting for next free slot`,
						);
						// Скользящее окно: ждём только один завершившийся файл, затем сразу продолжаем.
						await Promise.race(activeDownloads);
					}
				}
			}
			// Обновляем общую статистику пропущенных из текущей пачки
			skippedExisting += batchSkippedExisting;

			// Сохраняем обработанные сообщения в SQLite (сырые уже сохранены выше)
			logMessage.db(`Saving ${allMessages.length} processed messages to database`);
			db.saveMessages(channelId, outputFolder, [], allMessages);
			offsetId = messages[messages.length - 1].id;
			logMessage.fetch(`Batch complete: next offsetId=${offsetId}`);
			updateLastSelection({ messageOffsetId: offsetId });
			// Убран wait(3) для оптимизации - новые сообщения запрашиваются сразу
		} // конец inner try для outputFolder

		// Все сообщения обработаны, ждем завершения оставшихся загрузок
		if (activeDownloads.size > 0) {
			logMessage.info(`[DL] Waiting for ${activeDownloads.size} remaining files to be downloaded...`);
			await Promise.all([...activeDownloads]);
		}

		logMessage.success("[FETCH] All files downloaded successfully");
		logMessage.info(
			`[SUMMARY] Skipped: existing=${skippedExisting}, byType=${skippedByType}, byTextFilter=${skippedByTextFilter}`,
		);
		logMessage.info(
			`[SUMMARY] Total: fetched=${totalFetched}, downloaded=${successfulDownloads}, failed=${failedDownloads}, skipped=${skippedExisting}`,
		);

		// Очищаем кэши и закрываем соединение с БД после завершения
		clearFileCheckCache();
		db.closeDatabase(outputFolder);
		logMessage.fetch(`=== getMessages completed: channelId=${channelId} ===`);

		return true;
	} catch (err) {
		logMessage.error(
			`[FETCH] Error in getMessages: ${err?.message || String(err)}`,
		);
		if (typeof outputFolder !== 'undefined') {
			db.closeDatabase(outputFolder);
		}
	}
};

const getMessageDetail = async (client, channelId, messageIds, options = {}) => {
	const { check: enableCheck = false, deep: deepValidation = false } = options;
	let outputFolder;

	logMessage.fetch(`=== Starting getMessageDetail: channelId=${channelId}, messageIds=${JSON.stringify(messageIds)}, check=${enableCheck}, deep=${deepValidation} ===`);

	// Initialize FFmpeg for validation if needed
	let ffmpegPaths = null;
	if (enableCheck) {
		const ffmpegAvailable = await isFFmpegAvailable();
		if (!ffmpegAvailable) {
			logMessage.warn(`[VALID] ffmpeg not found, skipping file validation`);
		} else {
			ffmpegPaths = await getFFmpegPaths();
			if (deepValidation) {
				logMessage.info(`[VALID] File validation: ENABLED (DEEP mode - full decode)`);
			} else {
				logMessage.info(`[VALID] File validation: ENABLED (FAST mode - headers only)`);
			}
		}
	}

	try {
		const floodState = createFloodState();
		const result = await runWithFloodControl(
			floodState,
			"getMessagesByIds",
			async () => {
				const inputPeer = await getEntityResolver(client).resolve(channelId);
				return client.getMessages(inputPeer, {
					ids: messageIds,
				});
			},
		);
		logMessage.fetch(`getMessagesByIds returned ${result.length} messages for ids=${JSON.stringify(messageIds)}`);
		
		outputFolder = resolveOutputFolder(channelId, options);
		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder, { recursive: true });
			logMessage.fetch(`Created output folder: ${outputFolder}`);
		}
	
		// Инициализируем SQLite базу данных для этого канала
		logMessage.db(`Initializing database for channel: ${channelId}`);
		db.initDatabase(channelId, outputFolder);
		initDownloadState(channelId, outputFolder);

		db.saveMessages(channelId, outputFolder, result, []);

		let activeDownloads = new Set();
		let totalFilesToDownload = 0;
		let queuedDownloads = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		let skippedExisting = 0;
		let totalBytesDownloaded = 0;
		const downloadStartedAt = Date.now();
		let lastProgressLogAt = 0;
		const speedHistory = [];

		// Подсчитываем файлы и проверяем существование с прогресс-логированием
		const checkStartedAt = Date.now();
		let lastCheckProgressLogAt = 0;
		let checkedFiles = 0;
		const totalMediaMessages = result.filter(m => m.media).length;
		logMessage.fetch(`Checking ${totalMediaMessages} messages for media`);

		for (let i = 0; i < result.length; i++) {
			const message = result[i];
			if (message.media) {
				const mediaType = getMediaType(message);
				const mediaPath = getMediaPath(message, outputFolder);
				let fileExist = checkFileExist(message, outputFolder, channelId);
				logMessage.cache(`File check: msgId=${message.id}, type=${mediaType}, exists=${fileExist}`);

				// Validation: if file exists and check is enabled, validate it
				if (fileExist && enableCheck && ffmpegPaths) {
					const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
					if (deepValidation) {
						logMessage.valid(`Deep checking: ${path.basename(mediaPath)}`);
					}
					const validationResult = await validateFile(
						mediaPath,
						fileType,
						ffmpegPaths.ffmpeg,
						ffmpegPaths.ffprobe,
						deepValidation // true for deep, false for fast
					);

					if (!validationResult.valid) {
						logMessage.warn(`[VALID] File failed validation: ${path.basename(mediaPath)} - ${validationResult.error}`);
						logMessage.info(`[VALID] Will re-download: ${path.basename(mediaPath)}`);
						fileExist = false;
						// Remove invalid file so it can be re-downloaded
						try {
							if (fs.existsSync(mediaPath)) {
								fs.unlinkSync(mediaPath);
							}
						} catch (e) {
							logMessage.error(`[VALID] Failed to delete invalid file: ${e.message}`);
						}
						// Clear from cache
						fileCheckCache.delete(mediaPath);
					}
				}

				message._fileExist = fileExist; // Кэшируем результат
				checkedFiles += 1;

				// Логирование прогресса проверки
				const shouldLogCheck =
					checkedFiles % config.get('download.checkProgressIntervalFiles') === 0 ||
					Date.now() - lastCheckProgressLogAt >= CHECK_PROGRESS_INTERVAL_MS;
				if (shouldLogCheck) {
					logCheckProgress(
						checkedFiles,
						totalMediaMessages,
						skippedExisting,
						totalFilesToDownload,
						checkStartedAt,
					);
					lastCheckProgressLogAt = Date.now();
				}

				if (!fileExist) {
					totalFilesToDownload += 1;
					logMessage.dl(`Need download: msgId=${message.id}, file=${path.basename(getMediaPath(message, outputFolder))}`);
				} else {
					skippedExisting += 1;
					logMessage.cache(`File exists: ${path.basename(getMediaPath(message, outputFolder))} (skipped)`);
				}
			}
		}

		// Финальный лог прогресса проверки
		if (checkedFiles > 0) {
			logCheckProgress(
				checkedFiles,
				totalMediaMessages,
				skippedExisting,
				totalFilesToDownload,
				checkStartedAt,
			);
		}

		logMessage.fetch(`Starting downloads: ${totalFilesToDownload} new files`);
		for (let i = 0; i < result.length; i++) {
			let message = result[i];
			if (message.media) {
				// Используем кэшированный результат проверки
					const fileExist = message._fileExist !== undefined
						? message._fileExist
						: checkFileExist(message, outputFolder, channelId);
					if (fileExist) {
						logMessage.cache(`Skipping existing: msgId=${message.id}`);
						if (channelId && outputFolder) {
							db.setFileDownloaded(channelId, outputFolder, message.id, 1);
							downloadState.markDownloaded(message.id);
						}
						continue;
					}
					queuedDownloads += 1;
					const mediaPath = getMediaPath(message, outputFolder);
					logMessage.dl(`Queueing: msgId=${message.id}, file=${path.basename(mediaPath)}`);
					let downloadPromise;
					downloadPromise = downloadMessageMedia(
						client,
						message,
						mediaPath,
						floodState,
						channelId,
						outputFolder,
					)
					.then((result) => {
						if (result.success) {
							successfulDownloads += 1;
							totalBytesDownloaded += result.fileSize;
							// Добавляем скачанный файл в кэш проверки
							addFileToCheckCache(mediaPath, result.fileSize);
						} else {
							failedDownloads += 1;
						}
						const now = Date.now();
						const finished = successfulDownloads + failedDownloads;
						const shouldLogProgress =
							finished === queuedDownloads ||
							now - lastProgressLogAt >=
								PROGRESS_LOG_INTERVAL_SECONDS * 1000;
						if (shouldLogProgress) {
							logDownloadProgress(
								downloadStartedAt,
								totalFilesToDownload,
								successfulDownloads,
								failedDownloads,
								speedHistory,
								totalBytesDownloaded,
								activeDownloads.size,
								floodState.currentParallelLimit,
							);
							lastProgressLogAt = now;
						}
					})
					.catch(() => {
						failedDownloads += 1;
						const now = Date.now();
						const finished = successfulDownloads + failedDownloads;
						const shouldLogProgress =
							finished === queuedDownloads ||
							now - lastProgressLogAt >=
								PROGRESS_LOG_INTERVAL_SECONDS * 1000;
						if (shouldLogProgress) {
							logDownloadProgress(
								downloadStartedAt,
								totalFilesToDownload,
								successfulDownloads,
								failedDownloads,
								speedHistory,
								totalBytesDownloaded,
								activeDownloads.size,
								floodState.currentParallelLimit,
							);
							lastProgressLogAt = now;
						}
					})
					.finally(() => {
						activeDownloads.delete(downloadPromise);
					});
				activeDownloads.add(downloadPromise);
			}
			if (activeDownloads.size >= floodState.currentParallelLimit) {
				logMessage.dl(
					`Download queue is full (${floodState.currentParallelLimit}). Waiting for next free slot`,
				);
				await Promise.race(activeDownloads);
			}
		}

		if (activeDownloads.size > 0) {
			logMessage.info("[DL] Waiting for files to be downloaded");
			await Promise.all([...activeDownloads]);
			logMessage.success("[DL] Files downloaded successfully");
		}
		logMessage.info(`[SUMMARY] Skipped existing: ${skippedExisting}`);
		
		// Очищаем кэши и закрываем соединение с БД после завершения
		clearFileCheckCache();
		db.closeDatabase(outputFolder);
		logMessage.fetch(`=== getMessageDetail completed ===`);
		
		return result;
	} catch (err) {
		logMessage.error(
			`[FETCH] Error in getMessageDetail: ${err?.message || String(err)}`,
		);
		if (outputFolder) {
			db.closeDatabase(outputFolder);
		}
		throw err;
	}
};

const sendMessage = async (client, channelId, message) => {
	try {
		const inputPeer = await getEntityResolver(client).resolve(channelId);
		let res = await client.sendMessage(inputPeer, { message });

		logMessage.success(`[MSG] Message sent successfully with ID: ${res.id}`);
	} catch (err) {
		logMessage.error(
			`[MSG] Error in sendMessage: ${err?.message || String(err)}`,
		);
	}
};

// --- Listen Channel (Real-time monitoring) ---
// Обработчик новых сообщений для прослушивания канала
const handleNewMessage = async (event, client, channelId, options = {}) => {
	const messageChatId =
		event.message?.peerId?.chatId ||
		event.message?.peerId?.channelId ||
		event.message?.peerId?.userId;
	if (Number(messageChatId) !== Number(channelId)) {
		return;
	}

	const messageId = event.message?.id;
	const isMedia = !!event.message?.media;
	logMessage.dl(`[LISTEN] New message: msgId=${messageId}, hasMedia=${isMedia}`);
	if (isMedia) {
		const outputFolder = resolveOutputFolder(channelId, options);

		const details = await getMessageDetail(client, channelId, [messageId], { ...options, outputFolder });
		for (const msg of details) {
			await downloadMessageMedia(
				client,
				msg,
				getMediaPath(msg, outputFolder),
				createFloodState(),
				channelId,
				outputFolder
			);
			logMessage.success(`[LISTEN] Downloaded media from new message: ${msg.id}`);
		}
	}
};

// Запуск прослушивания канала в реальном времени
const startChannelListener = async (client, channelId, options = {}) => {
	const { NewMessage } = require("telegram/events");
	const { getDialogName, selectDialog, searchDialog, getAllDialogs } = require("./dialoges");
	const { selectInput, booleanInput } = require("../utils/input_helper");

	logMessage.init(`=== Starting channel listener ===`);

	// Если channelId не передан, проверяем последний выбор
	if (!channelId) {
		const lastSelection = getLastSelection();
		if (lastSelection.channelId) {
			const lastChannelName = await getDialogName(client, lastSelection.channelId, options);
			logMessage.init(`Found last selection: channelId=${lastSelection.channelId}, name=${lastChannelName}`);
			logMessage.info(`Last selected channel: ${lastChannelName || lastSelection.channelId}`);
			const useLastChannel = await booleanInput("Do you want to continue listening to this channel?", true);
			
			if (!useLastChannel) {
				// Поль��ователь хочет выбрать другой канал
				logMessage.init(`User wants to select new channel`);
				const wantToSearch = await booleanInput("Do you want to search for a channel?", false);
				if (wantToSearch) {
					const dialogs = await getAllDialogs(client, true, options);
					await searchDialog(dialogs);
				} else {
					const dialogs = await getAllDialogs(client, true, options);
					await selectDialog(dialogs);
				}
				const newSelection = getLastSelection();
				channelId = newSelection.channelId;
			} else {
				channelId = lastSelection.channelId;
				logMessage.init(`Using last channel: ${lastChannelName || channelId}`);
			}
		} else {
			// Нет сохраненного выбора, предлагаем выбрать канал
			logMessage.init(`No last selection found, prompting user to select`);
			const wantToSearch = await booleanInput("Do you want to search for a channel?", false);
			if (wantToSearch) {
				const dialogs = await getAllDialogs(client, true, options);
				await searchDialog(dialogs);
			} else {
				const dialogs = await getAllDialogs(client, true, options);
				await selectDialog(dialogs);
			}
			const newSelection = getLastSelection();
			channelId = newSelection.channelId;
		}
	}

	const dialogName = await getDialogName(client, channelId, options);
	logMessage.success(`[LISTEN] Started listening to: ${dialogName}`);
	
	client.addEventHandler(
		(event) => handleNewMessage(event, client, channelId, options),
		new NewMessage({})
	);
};

const rebuildDatabaseFromApi = async (client, channelId, options = {}) => {
	const outputFolder = resolveOutputFolder(channelId, options);
	const messageService = new MessageService(client);

	try {
		logMessage.db(`=== Starting rebuildDatabaseFromApi: channelId=${channelId}, outputFolder=${outputFolder} ===`);
		const result = await messageService.rebuildDatabaseFromApi(channelId, {
			...options,
			outputFolder,
			includeSnapshots: false,
		});
		logMessage.success(`[DB-REBUILD] Database rebuild complete: stored=${result.totalStored}, media=${result.totalMediaFound}`);
		return result;
	} catch (err) {
		logMessage.error(`[DB-REBUILD] Error rebuilding database: ${err?.message || String(err)}`);
		throw err;
	} finally {
		db.closeDatabase(outputFolder);
	}
};

// --- Download messages by IDs ---
const downloadMessagesByIds = async (client, channelId, messageIds, options = {}) => {
	try {
		logMessage.dl(`=== Starting downloadMessagesByIds: channelId=${channelId}, ids=${JSON.stringify(messageIds)} ===`);
		const outputFolder = resolveOutputFolder(channelId, options);
		await getMessageDetail(client, channelId, messageIds, { ...options, outputFolder });
		logMessage.success("[DL] Done with downloading messages");
	} catch (error) {
		logMessage.error(`[DL] Error downloading messages by IDs: ${error.message}`);
	}
};

module.exports = {
	getMessages,
	getMessageDetail,
	rebuildDatabaseFromApi,
	sendMessage,
	startChannelListener,
	downloadMessagesByIds,
};
