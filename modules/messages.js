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
	const outputFolder = resolveOutputFolder(channelId, options);
	const messageService = new MessageService(client);
	const downloadManager = new DownloadManager(client);
	const downloadStats = {
		queuedDownloads: 0,
		successfulDownloads: 0,
		failedDownloads: 0,
		skippedExisting: 0,
		skippedByType: 0,
		skippedByTextFilter: 0,
		totalBytesDownloaded: 0,
	};

	logMessage.fetch(`=== Starting getMessages: channelId=${channelId}, check=${enableCheck}, deep=${deepValidation} ===`);
	logMessage.fetch(`Config: messageLimit=${config.get('download.messageLimit')}, fastForwardMessageLimit=${config.get('download.fastForwardMessageLimit')}, lastKnownOffsetId=${lastKnownOffsetId}`);

	try {
		const fetchStats = await messageService.fetchMessages(
			channelId,
			{ ...options, outputFolder, lastKnownOffsetId },
			async (messages, context) => {
				const batchResult = await downloadManager.processMessageBatch(messages, {
					...context,
					downloadableFiles,
				});

				downloadStats.queuedDownloads += batchResult.queuedDownloads;
				downloadStats.successfulDownloads += batchResult.successfulDownloads;
				downloadStats.failedDownloads += batchResult.failedDownloads;
				downloadStats.skippedExisting += batchResult.skippedExisting;
				downloadStats.skippedByType += batchResult.skippedByType;
				downloadStats.skippedByTextFilter += batchResult.skippedByTextFilter;
				downloadStats.totalBytesDownloaded += batchResult.totalBytesDownloaded;

				if (context.nextOffsetId) {
					updateLastSelection({ messageOffsetId: context.nextOffsetId });
				}
			},
		);

		await downloadManager.waitForCompletion();

		logMessage.success("[FETCH] All files downloaded successfully");
		logMessage.info(
			`[SUMMARY] Skipped: existing=${downloadStats.skippedExisting}, byType=${downloadStats.skippedByType}, byTextFilter=${downloadStats.skippedByTextFilter}`,
		);
		logMessage.info(
			`[SUMMARY] Total: fetched=${fetchStats.totalFetched}, media=${fetchStats.totalMediaFound}, downloaded=${downloadStats.successfulDownloads}, failed=${downloadStats.failedDownloads}`,
		);
		logMessage.fetch(`=== getMessages completed: channelId=${channelId} ===`);

		return true;
	} catch (err) {
		logMessage.error(
			`[FETCH] Error in getMessages: ${err?.message || String(err)}`,
		);
		throw err;
	} finally {
		downloadManager.cleanup();
		messageService.cleanup();
		db.closeDatabase(outputFolder);
	}
};

const getMessageDetail = async (client, channelId, messageIds, options = {}) => {
	const { check: enableCheck = false, deep: deepValidation = false } = options;
	const outputFolder = resolveOutputFolder(channelId, options);
	const messageService = new MessageService(client);
	const downloadManager = new DownloadManager(client);

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
		const result = await messageService.getMessagesByIds(channelId, messageIds, { outputFolder });
		logMessage.fetch(`getMessagesByIds returned ${result.length} messages for ids=${JSON.stringify(messageIds)}`);

		const processedMessages = result
			.filter((message) => message.message != undefined || message.media != undefined)
			.map((message) => messageService.processMessage(message, outputFolder, channelId))
			.filter(Boolean);

		db.saveMessages(channelId, outputFolder, result, processedMessages);

		await downloadManager.processMessageBatch(result, {
			outputFolder,
			channelId,
			ffmpegPaths,
			deepValidation,
			floodState: messageService.floodState,
			downloadableFiles: { all: true },
		});
		await downloadManager.waitForCompletion();

		logMessage.fetch(`=== getMessageDetail completed ===`);
		return result;
	} catch (err) {
		logMessage.error(
			`[FETCH] Error in getMessageDetail: ${err?.message || String(err)}`,
		);
		throw err;
	} finally {
		downloadManager.cleanup();
		messageService.cleanup();
		db.closeDatabase(outputFolder);
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
		await getMessageDetail(client, channelId, [messageId], { ...options, outputFolder });
		logMessage.success(`[LISTEN] Downloaded media from new message: ${messageId}`);
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
