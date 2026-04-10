const path = require("path");
const db = require("../utils/db");
const paths = require("../utils/paths");
const config = require("../utils/config");
const {
    getMediaType,
    getMediaPath,
    getMediaRelativePath,
    buildFileName,
    filterString,
    logMessage,
    loadSnapshots,
    initDownloadState
} = require("../utils/helper");
const { createFloodState } = require("./FloodControl");
const { TelegramEntityResolver } = require("./TelegramEntityResolver");
const { isFFmpegAvailable, getFFmpegPaths, validateFile } = require("../validators");

const CHECK_PROGRESS_INTERVAL_MS = 5000;

/**
 * Сервис для получения сообщений из Telegram API
 */
class MessageService {
    constructor(client) {
        this.client = client;
        this.floodState = createFloodState();
        this.entityResolver = new TelegramEntityResolver(client);
    }

    /**
     * Получить сообщения канала с пагинацией
     * @param {string|number} channelId - ID канала
     * @param {Object} options - Опции
     * @param {Function} onBatch - Callback для каждой пачки сообщений
     * @returns {Promise<Object>} Статистика
     */
    async fetchMessages(channelId, options = {}, onBatch = null) {
        const { 
            check: enableCheck = false, 
            deep: deepValidation = false,
            outputFolder = paths.getChannelExportPath(channelId),
            lastKnownOffsetId = 0,
        } = options;

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

        paths.ensureDir(outputFolder);

        db.initDatabase(channelId, outputFolder);
        initDownloadState(channelId, outputFolder);

        const snapshotFiles = loadSnapshots(outputFolder);
        if (snapshotFiles.size > 0) {
            const syncedCount = db.syncDownloadedFromSnapshots(channelId, outputFolder, snapshotFiles);
            if (syncedCount > 0) {
                logMessage.info(`Synced ${syncedCount} existing files from snapshots as downloaded`);
                initDownloadState(channelId, outputFolder);
            }
        }

        let offsetId = 0;
        let totalFetched = 0;
        let totalMessagesInChannel = 0;
        let fastForwardMode = Number(lastKnownOffsetId) > 0;
        
        // Статистика
        const stats = {
            totalFetched: 0,
            totalMediaFound: 0,
            skippedExisting: 0,
            skippedByType: 0
        };

        while (true) {
            const inFastForwardRange =
                fastForwardMode &&
                (offsetId === 0 || offsetId > Number(lastKnownOffsetId));
            const messageLimit = inFastForwardRange
                ? config.get('download.fastForwardMessageLimit')
                : config.get('download.messageLimit');
            
            if (fastForwardMode && !inFastForwardRange) {
                logMessage.info(`Reached last known position. Switching to normal batch size ${config.get('download.messageLimit')}`);
                fastForwardMode = false;
            }

            logMessage.info(`Fetching next batch of messages (limit: ${messageLimit}, offset: ${offsetId})...`);
            
            let messages = await this.floodState.runWithFloodControl(
                "getMessages",
                async () => {
                    const inputPeer = await this.entityResolver.resolve(channelId);
                    return this.client.getMessages(inputPeer, {
                        limit: messageLimit,
                        offsetId: offsetId,
                    });
                }
            );

            totalFetched += messages.length;
            stats.totalFetched = totalFetched;

            if (totalMessagesInChannel === 0 && messages.total > 0) {
                totalMessagesInChannel = messages.total;
                stats.totalMessagesInChannel = totalMessagesInChannel;
                logMessage.info(`Total messages in channel: ${totalMessagesInChannel}`);
            }

            // Сохраняем сырые сообщения в БД
            db.saveMessages(channelId, outputFolder, messages, []);
            
            logMessage.info(`getting messages (${totalFetched}/${messages.total}): ${Math.round((totalFetched * 100) / messages.total)}%`);

            if (messages.length === 0) {
                logMessage.success(`Done with all messages (${totalFetched}) 100%`);
                break;
            }

            // Фильтрация и обработка сообщений
            const processedMessages = [];
            const filteredMessages = messages.filter(msg => msg.message != undefined || msg.media != undefined);
            
            for (const message of filteredMessages) {
                const processed = this.processMessage(message, outputFolder, channelId);
                if (processed) {
                    processedMessages.push(processed);
                    
                    // Статистика
                    if (processed.isMedia) {
                        stats.totalMediaFound++;
                    }
                }
            }

            // Сохраняем обработанные сообщения
            db.saveMessages(channelId, outputFolder, [], processedMessages);

            // Callback для обработки пачки
            if (onBatch) {
                await onBatch(messages, {
                    outputFolder,
                    channelId,
                    ffmpegPaths,
                    deepValidation,
                    floodState: this.floodState,
                    stats,
                    nextOffsetId: messages[messages.length - 1]?.id || offsetId,
                });
            }

            offsetId = messages[messages.length - 1].id;
        }

        return stats;
    }

    /**
     * Полностью восстанавливает SQLite базу сообщений из Telegram API,
     * не скачивая медиа и не меняя статус downloaded для новых записей.
     */
    async rebuildDatabaseFromApi(channelId, options = {}) {
        const {
            outputFolder = paths.getChannelExportPath(channelId),
            includeSnapshots = false,
        } = options;

        paths.ensureDir(outputFolder);
        db.initDatabase(channelId, outputFolder);
        initDownloadState(channelId, outputFolder);

        if (includeSnapshots) {
            const snapshotFiles = loadSnapshots(outputFolder);
            if (snapshotFiles.size > 0) {
                const syncedCount = db.syncDownloadedFromSnapshots(channelId, outputFolder, snapshotFiles);
                if (syncedCount > 0) {
                    logMessage.info(`Synced ${syncedCount} existing files from snapshots as downloaded`);
                }
            }
        }

        let offsetId = 0;
        let totalFetched = 0;
        let totalStored = 0;
        let totalMediaFound = 0;
        let totalMessagesInChannel = 0;

        while (true) {
            const messageLimit = config.get("download.messageLimit");
            logMessage.info(`[DB-REBUILD] Fetching next batch of messages (limit: ${messageLimit}, offset: ${offsetId})...`);

            const messages = await this.floodState.runWithFloodControl(
                "rebuildDatabaseFromApi",
                async () => {
                    const inputPeer = await this.entityResolver.resolve(channelId);
                    return this.client.getMessages(inputPeer, {
                        limit: messageLimit,
                        offsetId,
                    });
                }
            );

            if (totalMessagesInChannel === 0 && messages.total > 0) {
                totalMessagesInChannel = messages.total;
                logMessage.info(`[DB-REBUILD] Total messages in channel: ${totalMessagesInChannel}`);
            }

            if (messages.length === 0) {
                logMessage.success(`[DB-REBUILD] Done. Stored ${totalStored} messages from API`);
                break;
            }

            totalFetched += messages.length;

            const filteredMessages = messages.filter((msg) => msg.message != undefined || msg.media != undefined);
            const processedMessages = [];

            for (const message of filteredMessages) {
                const processed = this.processMessage(message, outputFolder, channelId);
                if (processed) {
                    processedMessages.push(processed);
                    if (processed.isMedia) {
                        totalMediaFound++;
                    }
                }
            }

            db.saveMessages(channelId, outputFolder, messages, processedMessages);
            totalStored += filteredMessages.length;

            const percent = messages.total > 0
                ? Math.round((totalFetched * 100) / messages.total)
                : 100;
            logMessage.info(`[DB-REBUILD] Progress: fetched=${totalFetched}/${messages.total || totalFetched} (${percent}%), stored=${totalStored}, media=${totalMediaFound}`);

            offsetId = messages[messages.length - 1].id;
        }

        return {
            totalFetched,
            totalStored,
            totalMediaFound,
            totalMessagesInChannel,
        };
    }

    /**
     * Обработать сообщение и извлечь метаданные
     */
    processMessage(message, outputFolder, channelId) {
        const obj = {
            id: message.id,
            message: message.message,
            date: message.date,
            out: message.out,
            sender: message.fromId?.userId || message.peerId?.userId,
        };

        if (message.media) {
            const mediaPath = getMediaPath(message, outputFolder);
            const fileName = path.basename(mediaPath);
            obj.mediaType = message.media ? getMediaType(message) : null;
            obj.mediaPath = getMediaRelativePath(message);
            obj.mediaName = fileName;
            obj.isMedia = true;
        }

        return obj;
    }

    /**
     * Получить детали сообщений по ID
     */
    async getMessagesByIds(channelId, messageIds, options = {}) {
        const { outputFolder = paths.getChannelExportPath(channelId) } = options;
        paths.ensureDir(outputFolder);
        
        db.initDatabase(channelId, outputFolder);

        const result = await this.floodState.runWithFloodControl(
            "getMessagesByIds",
            async () => {
                const inputPeer = await this.entityResolver.resolve(channelId);
                return this.client.getMessages(inputPeer, {
                    ids: messageIds,
                });
            }
        );

        return result;
    }

    cleanup() {
        this.floodState.cleanup();
    }
}

/**
 * Обработать сообщение и получить путь к медиа
 */
const processMessageMedia = (message, outputFolder) => {
    if (!message.media) return null;
    
    const mediaPath = getMediaPath(message, outputFolder);
    const mediaType = getMediaType(message);
    const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");
    
    return {
        mediaPath,
        mediaType,
        mediaExtension,
        fileName: buildFileName(message)
    };
};

/**
 * Проверить, нужно ли скачивать файл
 */
const shouldDownload = (mediaType, mediaExtension, downloadableFiles) => {
    return downloadableFiles[mediaType] ||
           downloadableFiles[mediaExtension] ||
           downloadableFiles["all"];
};

module.exports = {
    MessageService,
    processMessageMedia,
    shouldDownload,
    CHECK_PROGRESS_INTERVAL_MS
};
