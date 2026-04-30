const config = require("../utils/config");
const { logMessage } = require("../utils/helper");
const { getLastSelection, updateLastSelection } = require("../utils/file_helper");
const db = require("../utils/db");
const paths = require("../utils/paths");
const { MessageService } = require("../services/MessageService");
const { DownloadManager } = require("../services/DownloadManager");
const { TelegramEntityResolver } = require("../services/TelegramEntityResolver");
const { isFFmpegAvailable, getFFmpegPaths } = require("../validators");

const resolveOutputFolder = (channelId, options = {}) =>
	options.outputFolder || paths.getChannelExportPath(channelId, options.exportPath);

const getEntityResolver = (client) => {
	if (!client.__tgdlEntityResolver) {
		client.__tgdlEntityResolver = new TelegramEntityResolver(client);
	}
	return client.__tgdlEntityResolver;
};

const getLastKnownOffsetId = () => Number(getLastSelection().messageOffsetId || 0);

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

	logMessage.fetch(
		`=== Starting getMessages: channelId=${channelId}, check=${enableCheck}, deep=${deepValidation} ===`,
	);
	logMessage.fetch(
		`Config: messageLimit=${config.get("download.messageLimit")}, fastForwardMessageLimit=${config.get("download.fastForwardMessageLimit")}, lastKnownOffsetId=${lastKnownOffsetId}`,
	);

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
		logMessage.error(`[FETCH] Error in getMessages: ${err?.message || String(err)}`);
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

	logMessage.fetch(
		`=== Starting getMessageDetail: channelId=${channelId}, messageIds=${JSON.stringify(messageIds)}, check=${enableCheck}, deep=${deepValidation} ===`,
	);

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
		logMessage.error(`[FETCH] Error in getMessageDetail: ${err?.message || String(err)}`);
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
		logMessage.error(`[MSG] Error in sendMessage: ${err?.message || String(err)}`);
	}
};

// --- Listen Channel (Real-time monitoring) ---
// Обработчик новых сообщений для прослушивания канала
const handleNewMessage = async (event, client, channelId, options = {}) => {
	const messageChatId =
		event.message?.peerId?.chatId || event.message?.peerId?.channelId || event.message?.peerId?.userId;
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
				// Пользователь хочет выбрать другой канал
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

	client.addEventHandler((event) => handleNewMessage(event, client, channelId, options), new NewMessage({}));
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
		logMessage.success(
			`[DB-REBUILD] Database rebuild complete: stored=${result.totalStored}, media=${result.totalMediaFound}`,
		);
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
		logMessage.dl(
			`=== Starting downloadMessagesByIds: channelId=${channelId}, ids=${JSON.stringify(messageIds)} ===`,
		);
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
