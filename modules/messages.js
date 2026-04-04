const fs = require("fs");
const {
	getMediaType,
	logMessage,
	wait,
	circularStringify,
	checkFileExist,
	getMediaPath,
	populateFileCache,
	clearFileCache,
	clearFileCheckCache,
	addFileToCheckCache,
	buildFileName,
	filterString,
	fileCheckCache,
} = require("../utils/helper");
const {
	getLastSelection,
	updateLastSelection,
} = require("../utils/file_helper");
const {
	deduplicateChannelFiles,
} = require("../utils/migration");
const db = require("../utils/db");
const path = require("path");

// Import validators for deep file checking
const { isFFmpegAvailable, getFFmpegPaths, validateFile } = require("../validators");

const MAX_PARALLEL_DOWNLOAD = 20;
const MESSAGE_LIMIT = 200;

// Флаг для будущих текстовых фильтров. Сейчас они отключены,
// но логика оставлена в коде и может быть легко включена.
const ENABLE_TEXT_FILTERS = false;
const MIN_PARALLEL_DOWNLOAD = 2;
const BASE_RPC_DELAY_SECONDS = 0.05;
const MAX_RPC_RETRIES = 5;
const PROGRESS_LOG_INTERVAL_SECONDS = 5;
const FAST_FORWARD_MESSAGE_LIMIT = 1000;

// Интервалы для логирования прогресса проверки файлов
const CHECK_PROGRESS_INTERVAL_FILES = 100;
const CHECK_PROGRESS_INTERVAL_MS = 5000;

// Логирование прогресса проверки файлов
const logCheckProgress = (checked, total, skipped, newFiles, startedAt) => {
	const percent = total > 0 ? Math.round((checked * 100) / total) : 100;
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	const timestamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
	logMessage.info(
		`[${timestamp}] Check progress: ${checked}/${total} (${percent}%), skipped: ${skipped}, new: ${newFiles}, elapsed: ${elapsed}s`,
	);
};

// Всегда начинаем с самого начала истории канала.
let { messageOffsetId } = { messageOffsetId: 0 };
const { messageOffsetId: lastKnownOffsetId = 0 } = getLastSelection();

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
	maxParallel = MAX_PARALLEL_DOWNLOAD,
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
		`[${timestamp}] [Queue: ${activeDownloads}/${maxParallel}] Download progress: ${finished}/${totalFiles} (${percent}%), failed: ${failed}, speed: ${speedText}, downloaded: ${formatBytes(totalBytesDownloaded)}, ETA: ${eta}`,
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

const createFloodState = () => ({
	cooldownUntil: 0,
	currentParallelLimit: MAX_PARALLEL_DOWNLOAD,
	consecutiveFloods: 0,
	successStreak: 0,
});

const maybeWaitCooldown = async (state) => {
	const now = Date.now();
	if (state.cooldownUntil > now) {
		const remainingSeconds = Math.ceil((state.cooldownUntil - now) / 1000);
		logMessage.info(
			`Flood cooldown active, waiting ${remainingSeconds}s before next API call`,
		);
		await wait(remainingSeconds);
	}
};

const runWithFloodControl = async (state, label, fn) => {
	for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
		await maybeWaitCooldown(state);
		if (BASE_RPC_DELAY_SECONDS > 0) {
			await wait(BASE_RPC_DELAY_SECONDS);
		}
		try {
			const result = await fn();
			state.successStreak += 1;
			if (
				state.successStreak >= 30 &&
				state.currentParallelLimit < MAX_PARALLEL_DOWNLOAD
			) {
				state.currentParallelLimit += 1;
				state.successStreak = 0;
				logMessage.info(
					`Flood control: increased parallel limit to ${state.currentParallelLimit}`,
				);
			}
			return result;
		} catch (err) {
			const floodSeconds = parseFloodWaitSeconds(err);
			if (floodSeconds) {
				state.consecutiveFloods += 1;
				state.successStreak = 0;
				state.currentParallelLimit = Math.max(
					MIN_PARALLEL_DOWNLOAD,
					state.currentParallelLimit - 1,
				);
				state.cooldownUntil = Date.now() + (floodSeconds + 1) * 1000;
				logMessage.error(
					`Flood detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit now ${state.currentParallelLimit}`,
				);
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

const downloadMessageMedia = async (client, message, mediaPath, floodState) => {
	try {
		if (message.media) {
			if (message.media.webpage) {
				let url = message.media.webpage.url;
				if (url) {
					let urlPath = path.join(
						mediaPath,
						`../${message.id}_url.txt`,
					);
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

				fs.writeFileSync(
					pollPath,
					circularStringify(message.media.poll, null, 2),
				);
			}

			let fileSize = 0;
			await runWithFloodControl(floodState, "downloadMedia", async () => {
				return client.downloadMedia(message, {
					outputFile: mediaPath,
					progressCallback: (downloaded, total) => {
						fileSize = downloaded;
						const name = path.basename(mediaPath);
						if (total == downloaded) {
							logMessage.success(
								`file ${name} downloaded successfully`,
							);
						}
					},
				});
			});

			// Если fileSize не обновился, получаем размер файла из файловой системы
			if (fileSize === 0 && fs.existsSync(mediaPath)) {
				fileSize = fs.statSync(mediaPath).size;
			}

			return { success: true, fileSize };
		} else {
			return { success: false, fileSize: 0 };
		}
	} catch (err) {
		logMessage.error(
			`Error in downloadMessageMedia(): ${err?.message || String(err)}`,
		);
		return { success: false, fileSize: 0 };
	}
};

const getMessages = async (client, channelId, downloadableFiles = {}, options = {}) => {
	const { check: enableCheck = false, deep: deepValidation = false } = options;

	// Initialize FFmpeg for validation if needed
	let ffmpegPaths = null;
	if (enableCheck) {
		const ffmpegAvailable = await isFFmpegAvailable();
		if (!ffmpegAvailable) {
			logMessage.warn(`ffmpeg not found, skipping file validation`);
		} else {
			ffmpegPaths = await getFFmpegPaths();
			if (deepValidation) {
				logMessage.info(`File validation: ENABLED (DEEP mode - full decode)`);
			} else {
				logMessage.info(`File validation: ENABLED (FAST mode - headers only)`);
			}
		}
	}
	try {
		const floodState = createFloodState();
		let offsetId = messageOffsetId;
		let fastForwardMode = Number(lastKnownOffsetId) > 0;
		let outputFolder = path.join(__dirname, "../export/", `${channelId}`);
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
		}

		// Единоразовая очистка дубликатов при старте
		deduplicateChannelFiles(outputFolder);

		// Инициализируем SQLite базу данных для этого канала
		db.initDatabase(channelId, outputFolder);

		// Set для отслеживания уже записанных ID (предотвращение дубликатов в сессии)
		const knownMessageIds = new Set();

		// Заполняем кэш существующих файлов для быстрой проверки
		const mediaTypes = ["image", "video", "audio", "document", "webpage", "poll", "geo", "venue", "contact", "sticker", "others"];
		populateFileCache(outputFolder, mediaTypes);

		// Очередь загрузок теперь живет на протяжении всего процесса
		let activeDownloads = new Set();

		while (true) {
			const inFastForwardRange =
				fastForwardMode &&
				(offsetId === 0 || offsetId > Number(lastKnownOffsetId));
			const messageLimit = inFastForwardRange
				? FAST_FORWARD_MESSAGE_LIMIT
				: MESSAGE_LIMIT;
			if (fastForwardMode && !inFastForwardRange) {
				logMessage.info(
					`Reached last known position (${lastKnownOffsetId}). Switching to normal batch size ${MESSAGE_LIMIT}`,
				);
				fastForwardMode = false;
			}

			let allMessages = [];
			logMessage.info(`Fetching next batch of messages (limit: ${messageLimit}, offset: ${offsetId})...`);
			let messages = await runWithFloodControl(
				floodState,
				"getMessages",
				async () => {
					return client.getMessages(channelId, {
						limit: messageLimit,
						offsetId: offsetId,
					});
				},
			);
			totalFetched += messages.length;

			// Получаем общее количество сообщений в канале из первого ответа
			if (totalMessagesInChannel === 0 && messages.total > 0) {
				totalMessagesInChannel = messages.total;
				logMessage.info(
					`Total messages in channel: ${totalMessagesInChannel}`,
				);
			}

			// Сохраняем сырые сообщения в SQLite для оптимизации (вместо JSON файлов)
			db.saveMessages(channelId, outputFolder, messages, []);
			logMessage.info(
				`getting messages (${totalFetched}/${
					messages.total
				}) : ${Math.round((totalFetched * 100) / messages.total)}%`,
			);
			messages = messages.filter(
				(message) =>
					message.message != undefined || message.media != undefined,
			);
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
					obj.mediaPath = getMediaPath(message, outputFolder);
					obj.mediaName = fileName;
					obj.isMedia = true;
				}

				allMessages.push(obj);
			});

			if (messages.length === 0) {
				logMessage.success(
					`Done with all messages (${totalFetched}) 100%`,
				);
				// В конце использу фактическое количество
				totalFilesToDownload = actualFilesFound;
				break;
			}

			// Подсчитываем файлы для скачивания в текущей партии и проверяем существование
			let batchFilesToDownload = 0;
			let batchSkippedExisting = 0;
			let batchNewFiles = 0;
			const checkStartedAt = Date.now();
			let lastCheckProgressLogAt = 0;
			let checkedFiles = 0;

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
					if (shouldDownload) {
						// Проверяем существование файла и кэшируем результат
						let fileExist = checkFileExist(message, outputFolder);
	
						// Validation: if file exists and check is enabled, validate it
						if (fileExist && enableCheck && ffmpegPaths) {
							const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
							if (deepValidation) {
								logMessage.info(`Checking (deep): ${path.basename(mediaPath)}...`);
							}
							const validationResult = await validateFile(
								mediaPath,
								fileType,
								ffmpegPaths.ffmpeg,
								ffmpegPaths.ffprobe,
								deepValidation // true for deep, false for fast
							);
	
							if (!validationResult.valid) {
								logMessage.warn(`File failed validation: ${path.basename(mediaPath)} - ${validationResult.error}`);
								logMessage.info(`Will re-download: ${path.basename(mediaPath)}`);
								fileExist = false;
								// Remove invalid file so it can be re-downloaded
								try {
									if (fs.existsSync(mediaPath)) {
										fs.unlinkSync(mediaPath);
									}
								} catch (e) {
									logMessage.error(`Failed to delete invalid file: ${e.message}`);
								}
								// Clear from cache so it's not used
								fileCheckCache.delete(mediaPath);
							}
						}
	
						message._fileExist = fileExist; // Кэшируем для последующего использования
						checkedFiles += 1;
	
						// Логирование прогресса проверки
						const shouldLogCheck =
							checkedFiles % CHECK_PROGRESS_INTERVAL_FILES === 0 ||
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
							logMessage.debug(`File exists: ${path.basename(mediaPath)} (skipped)`);
						} else {
							batchNewFiles += 1;
							batchFilesToDownload += 1;
						}
					}
				}
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
				} else {
					// При малом количестве сканированных сообщений используем фактическое число
					// Это предотвращает экстраполяцию на основе первых "горячих" сообщений
					totalFilesToDownload = Math.max(
						totalFilesToDownload,
						actualFilesFound,
					);
				}
			} else {
				totalFilesToDownload = actualFilesFound;
			}

			// Логируем оценку каждые 500 сообщений
			if (totalFetched % 500 < MESSAGE_LIMIT) {
				// Добавляем информацию о проценте медиа для наглядности
				const mediaPercent =
					totalFetched > 0
						? ((actualFilesFound / totalFetched) * 100).toFixed(1)
						: 0;
				logMessage.info(
					`Files estimate: found=${actualFilesFound}, estimated total=${totalFilesToDownload} (scanned ${totalFetched}/${totalMessagesInChannel}, media rate: ${mediaPercent}%)`,
				);
			}

			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.media) {
					const mediaType = getMediaType(message);
					const mediaPath = getMediaPath(message, outputFolder);
					// Используем кэшированный результат проверки вместо повторного вызова
					const fileExist = message._fileExist !== undefined
						? message._fileExist
						: checkFileExist(message, outputFolder);

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
					}

					const shouldDownload =
						downloadableFiles[mediaType] ||
						downloadableFiles[mediaExtension] ||
						downloadableFiles["all"];

					if (shouldDownload && !fileExist && textMatchesFilters) {
						await wait(0.2);
						logMessage.info(
							`Start Downloading file ${mediaPath} (${mediaExtension}) `,
						);
						queuedDownloads += 1;
						let downloadPromise;
						downloadPromise = downloadMessageMedia(
							client,
							message,
							mediaPath,
							floodState,
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
						logMessage.debug(
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
			db.saveMessages(channelId, outputFolder, messages, allMessages);
			offsetId = messages[messages.length - 1].id;
			updateLastSelection({ messageOffsetId: offsetId });
			// Убран wait(3) для оптимизации - новые сообщения запрашиваются сразу
		}

		// Все сообщения обработаны, ждем завершения оставшихся загрузок
		if (activeDownloads.size > 0) {
			logMessage.info(`Waiting for ${activeDownloads.size} remaining files to be downloaded...`);
			await Promise.all([...activeDownloads]);
		}

		logMessage.success("All files downloaded successfully");
		logMessage.info(
			`Skip summary: existing=${skippedExisting}, byType=${skippedByType}, byTextFilter=${skippedByTextFilter}`,
		);
		logMessage.info(
			`Total: fetched=${totalFetched}, downloaded=${successfulDownloads}, failed=${failedDownloads}, skipped=${skippedExisting}`,
		);

		// Очищаем кэши и закрываем соединение с БД после завершения
		clearFileCache();
		clearFileCheckCache();
		db.closeDatabase(outputFolder);

		return true;
	} catch (err) {
		logMessage.error(
			`Error in getMessages(): ${err?.message || String(err)}`,
		);
		// Закрываем БД в случае ошибки
		db.closeDatabase(outputFolder);
	}
};

const getMessageDetail = async (client, channelId, messageIds, options = {}) => {
	const { check: enableCheck = false, deep: deepValidation = false } = options;

	// Initialize FFmpeg for validation if needed
	let ffmpegPaths = null;
	if (enableCheck) {
		const ffmpegAvailable = await isFFmpegAvailable();
		if (!ffmpegAvailable) {
			logMessage.warn(`ffmpeg not found, skipping file validation`);
		} else {
			ffmpegPaths = await getFFmpegPaths();
			if (deepValidation) {
				logMessage.info(`File validation: ENABLED (DEEP mode - full decode)`);
			} else {
				logMessage.info(`File validation: ENABLED (FAST mode - headers only)`);
			}
		}
	}

	try {
		const floodState = createFloodState();
		const result = await runWithFloodControl(
			floodState,
			"getMessagesByIds",
			async () => {
				return client.getMessages(channelId, {
					ids: messageIds,
				});
			},
		);
		let outputFolder = `./export/${channelId}`;
		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder);
		}
	
		// Инициализируем SQLite базу данных для этого канала
		db.initDatabase(channelId, outputFolder);
	
		// Заполняем кэш существующих файлов для быстрой проверки
		const mediaTypes = ["image", "video", "audio", "document", "webpage", "poll", "geo", "venue", "contact", "sticker", "others"];
		populateFileCache(outputFolder, mediaTypes);

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

		for (let i = 0; i < result.length; i++) {
			const message = result[i];
			if (message.media) {
				const mediaType = getMediaType(message);
				const mediaPath = getMediaPath(message, outputFolder);
				let fileExist = checkFileExist(message, outputFolder);

				// Validation: if file exists and check is enabled, validate it
				if (fileExist && enableCheck && ffmpegPaths) {
					const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
					if (deepValidation) {
						logMessage.info(`Checking (deep): ${path.basename(mediaPath)}...`);
					}
					const validationResult = await validateFile(
						mediaPath,
						fileType,
						ffmpegPaths.ffmpeg,
						ffmpegPaths.ffprobe,
						deepValidation // true for deep, false for fast
					);

					if (!validationResult.valid) {
						logMessage.warn(`File failed validation: ${path.basename(mediaPath)} - ${validationResult.error}`);
						logMessage.info(`Will re-download: ${path.basename(mediaPath)}`);
						fileExist = false;
						// Remove invalid file so it can be re-downloaded
						try {
							if (fs.existsSync(mediaPath)) {
								fs.unlinkSync(mediaPath);
							}
						} catch (e) {
							logMessage.error(`Failed to delete invalid file: ${e.message}`);
						}
						// Clear from cache
						fileCheckCache.delete(mediaPath);
					}
				}

				message._fileExist = fileExist; // Кэшируем результат
				checkedFiles += 1;

				// Логирование прогресса проверки
				const shouldLogCheck =
					checkedFiles % CHECK_PROGRESS_INTERVAL_FILES === 0 ||
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
				} else {
					skippedExisting += 1;
					logMessage.debug(`File exists: ${path.basename(getMediaPath(message, outputFolder))} (skipped)`);
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

		for (let i = 0; i < result.length; i++) {
			let message = result[i];
			if (message.media) {
				// Используем кэшированный результат проверки
				const fileExist = message._fileExist !== undefined
					? message._fileExist
					: checkFileExist(message, outputFolder);
				if (fileExist) {
					continue; // Пропускаем существующие файлы
				}
				queuedDownloads += 1;
				const mediaPath = getMediaPath(message, outputFolder);
				let downloadPromise;
				downloadPromise = downloadMessageMedia(
					client,
					message,
					mediaPath,
					floodState,
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
				logMessage.debug(
					`Download queue is full (${floodState.currentParallelLimit}). Waiting for next free slot`,
				);
				await Promise.race(activeDownloads);
			}
		}

		if (activeDownloads.size > 0) {
			logMessage.info("Waiting for files to be downloaded");
			await Promise.all([...activeDownloads]);
			logMessage.success("Files downloaded successfully");
		}
		logMessage.info(`Skip summary: existing=${skippedExisting}`);
		
		// Очищаем кэши и закрываем соединение с БД после завершения
		clearFileCache();
		clearFileCheckCache();
		db.closeDatabase(outputFolder);
		
		return true;
	} catch (err) {
		logMessage.error(
			`Error in getMessageDetail(): ${err?.message || String(err)}`,
		);
		// Закрываем БД в случае ошибки
		db.closeDatabase(outputFolder);
	}
};

const sendMessage = async (client, channelId, message) => {
	try {
		let res = await client.sendMessage(channelId, { message });

		logMessage.success(`Message sent successfully with ID: ${res.id}`);
	} catch (err) {
		logMessage.error(
			`Error in sendMessage(): ${err?.message || String(err)}`,
		);
	}
};

module.exports = {
	getMessages,
	getMessageDetail,
	sendMessage,
};
