const fs = require("fs");
const path = require("path");
const db = require("../utils/db");
const paths = require("../utils/paths");
const { 
    getMediaType, 
    getMediaPath, 
    buildFileName, 
    filterString,
    checkFileExist,
    addFileToCheckCache,
    clearFileCheckCache,
    fileCheckCache,
    logMessage,
    wait,
    loadSnapshots
} = require("../utils/helper");
const { createFloodState, MAX_PARALLEL_DOWNLOAD } = require("./FloodControl");
const { ProgressLogger } = require("./ProgressLogger");
const { isFFmpegAvailable, getFFmpegPaths, validateFile } = require("../validators");

/**
 * Сервис для управления загрузкой файлов
 */
class DownloadManager {
    constructor(client) {
        this.client = client;
        this.activeDownloads = new Set();
        logMessage.dl(`[DL] DownloadManager created, client type: ${typeof client}`);
    }

    /**
     * Скачать медиа из сообщения
     */
    async downloadMedia(message, mediaPath, floodState, channelId, outputFolder) {
        const msgId = message?.id;
        const mediaType = message?.media ? getMediaType(message) : "none";
        
        logMessage.dl(`[DL] downloadMedia: msgId=${msgId}, type=${mediaType}, path=${mediaPath}`);
        
        try {
            if (!message.media) {
                logMessage.dl(`[DL] No media in message: msgId=${msgId}`);
                return { success: false, fileSize: 0 };
            }

            // Обработка webpage
            if (message.media.webpage) {
                let url = message.media.webpage.url;
                if (url) {
                    let urlPath = path.join(mediaPath, `../${message.id}_url.txt`);
                    logMessage.dl(`[DL] Saving webpage URL: ${url}`);
                    fs.writeFileSync(urlPath, url);
                }
                mediaPath = path.join(mediaPath, `../${message?.media?.webpage?.id}_image.jpeg`);
            }

            // Обработка poll
            if (message.media.poll) {
                let pollPath = path.join(mediaPath, `../${message.id}_poll.json`);
                const { circularStringify } = require("../utils/helper");
                logMessage.dl(`[DL] Saving poll data for msgId=${msgId}`);
                fs.writeFileSync(pollPath, circularStringify(message.media.poll, null, 2));
            }

            let fileSize = 0;
            
            logMessage.dl(`[DL] Starting Telegram download: msgId=${msgId}`);
            await floodState.runWithFloodControl(`downloadMedia-msg${msgId}`, async () => {
                return this.client.downloadMedia(message, {
                    outputFile: mediaPath,
                    progressCallback: (downloaded, total) => {
                        fileSize = downloaded;
                        const name = path.basename(mediaPath);
                        if (total == downloaded) {
                            logMessage.dl(`[DL] Download complete: msgId=${msgId}, file=${name}, size=${fileSize}`);
                        }
                    },
                });
            });

            // Если fileSize не обновился, получаем размер файла из файловой системы
            if (fileSize === 0 && fs.existsSync(mediaPath)) {
                fileSize = fs.statSync(mediaPath).size;
                logMessage.dl(`[DL] File size from fs: msgId=${msgId}, size=${fileSize}`);
            }

            // Отмечаем файл как скачанный в БД
            if (channelId && outputFolder) {
                db.setFileDownloaded(channelId, outputFolder, message.id, 1);
                logMessage.dl(`[DL] Marked downloaded in DB: msgId=${msgId}, channelId=${channelId}`);
            }

            return { success: true, fileSize };
        } catch (err) {
            logMessage.error(`[DL] Error in downloadMedia: msgId=${msgId}, error=${err?.message || String(err)}`);
            return { success: false, fileSize: 0 };
        }
    }

    /**
     * Проверить файл на валидность
     */
    async validateMediaFile(mediaPath, mediaType, ffmpegPaths, deepValidation) {
        if (!ffmpegPaths) {
            logMessage.valid(`[VALID] No ffmpeg paths, skipping validation: ${mediaPath}`);
            return true;
        }
        
        try {
            const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
            logMessage.valid(`[VALID] Starting validation: file=${path.basename(mediaPath)}, type=${fileType}, deep=${deepValidation}`);
            
            const validationStart = Date.now();
            const validationResult = await validateFile(
                mediaPath,
                fileType,
                ffmpegPaths.ffmpeg,
                ffmpegPaths.ffprobe,
                deepValidation
            );
            const validationMs = Date.now() - validationStart;
            
            if (validationResult.valid) {
                logMessage.valid(`[VALID] Valid: ${path.basename(mediaPath)} (${validationMs}ms)`);
            } else {
                logMessage.valid(`[VALID] Invalid: ${path.basename(mediaPath)} - ${validationResult.error} (${validationMs}ms)`);
            }
            
            return validationResult;
        } catch (err) {
            logMessage.error(`[VALID] Error validating file ${mediaPath}: ${err.message}`);
            return { valid: true }; // На всякий случай считаем файл валидным
        }
    }

    /**
     * Удалить невалидный файл
     */
    deleteInvalidFile(mediaPath) {
        logMessage.valid(`[VALID] Deleting invalid file: ${mediaPath}`);
        try {
            if (fs.existsSync(mediaPath)) {
                fs.unlinkSync(mediaPath);
            }
            fileCheckCache.delete(mediaPath);
            return true;
        } catch (e) {
            logMessage.error(`[VALID] Failed to delete invalid file: ${e.message}`);
            return false;
        }
    }

    /**
     * Обработать пачку сообщений и инициировать загрузки
     */
    async processMessageBatch(messages, context) {
        const { 
            outputFolder, 
            channelId, 
            ffmpegPaths, 
            deepValidation, 
            floodState,
            downloadableFiles
        } = context;

        logMessage.dl(`[DL] processMessageBatch: channelId=${channelId}, messageCount=${messages.length}`);
        
        // Подсчет файлов для скачивания
        let batchFilesToDownload = 0;
        let batchSkippedExisting = 0;
        let batchNewFiles = 0;
        const checkStartedAt = Date.now();
        let lastCheckProgressLogAt = 0;
        let checkedFiles = 0;

        // Инициализация очереди загрузок
        const downloadQueue = [];
        let queuedDownloads = 0;
        let successfulDownloads = 0;
        let failedDownloads = 0;
        let skippedExisting = 0;
        let skippedByType = 0;
        let skippedByTextFilter = 0;
        let totalBytesDownloaded = 0;
        
        const progressLogger = new ProgressLogger({
            maxParallel: floodState.getParallelLimit()
        });

        // Debug: Track timing for validation vs other operations
        let validationCount = 0;
        let validationTotalMs = 0;
        let checkExistTotalMs = 0;
        const checkExistStart = Date.now();
        
        // First pass: check file existence (fast operation)
        const filesToValidate = [];
        
        logMessage.dl(`[DL] First pass: checking ${messages.length} messages for media`);
        for (const message of messages) {
            if (message.media) {
                const mediaType = getMediaType(message);
                const mediaPath = getMediaPath(message, outputFolder);
                const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");
                const shouldDownload = downloadableFiles[mediaType] ||
                                      downloadableFiles[mediaExtension] ||
                                      downloadableFiles["all"];
                
                if (shouldDownload) {
                    const fileExistStart = Date.now();
                    let fileExist = checkFileExist(message, outputFolder, channelId);
                    const fileExistEnd = Date.now();
                    checkExistTotalMs += (fileExistEnd - fileExistStart);

                    message._fileExist = fileExist;
                    message._mediaPath = mediaPath;
                    message._mediaType = mediaType;
                    checkedFiles++;

                    if (fileExist) {
                        // Collect files that need validation
                        // Skip files from snapshots - they are already verified
                        if (ffmpegPaths && !message._fromSnapshot) {
                            filesToValidate.push({
                                message,
                                mediaPath,
                                mediaType
                            });
                        }
                        batchSkippedExisting++;
                        skippedExisting++;
                        logMessage.cache(`[CACHE] File exists (skipped): ${path.basename(mediaPath)}`);
                    } else {
                        batchNewFiles++;
                        batchFilesToDownload++;
                        logMessage.dl(`[DL] Need download: msgId=${message.id}, type=${mediaType}, file=${path.basename(mediaPath)}`);
                    }

                    // Логирование прогресса проверки
                    const shouldLogCheck = checkedFiles % 100 === 0 ||
                                          Date.now() - lastCheckProgressLogAt >= 5000;
                    if (shouldLogCheck) {
                        ProgressLogger.logCheckProgress(
                            checkedFiles,
                            messages.filter(m => m.media).length,
                            batchSkippedExisting,
                            batchNewFiles,
                            checkStartedAt
                        );
                        lastCheckProgressLogAt = Date.now();
                    }
                } else {
                    logMessage.filter(`[FILTER] Skip by type: msgId=${message.id}, type=${mediaType}`);
                    skippedByType++;
                }
            }
        }
        
        // Parallel validation for existing files
        if (filesToValidate.length > 0 && ffmpegPaths) {
            const { validateFiles } = require("../validators");
            const ffmpegBin = ffmpegPaths.ffmpeg;
            const ffprobeBin = ffmpegPaths.ffprobe;
            const maxParallelValidation = Math.min(10, floodState.getParallelLimit());
            
            logMessage.valid(`[VALID] Starting parallel validation: count=${filesToValidate.length}, maxParallel=${maxParallelValidation}`);
            
            // Prepare files array with path and type for validateFiles
            const filesForValidation = filesToValidate.map(f => ({
                path: f.mediaPath,
                type: f.mediaType.toLowerCase().includes("video") ? "video" : "image"
            }));
            
            const validationStart = Date.now();
            const validationResults = await validateFiles(
                filesForValidation,
                { ffmpeg: ffmpegBin, ffprobe: ffprobeBin },
                (file, result) => {
                    logMessage.valid(`[VALID] Result: ${path.basename(file.path)} = ${result.valid ? 'valid' : 'invalid'}: ${result.error || ''}`);
                },
                maxParallelValidation,
                deepValidation
            );
            const validationElapsed = Date.now() - validationStart;
            logMessage.valid(`[VALID] Parallel validation complete: ${validationResults.errors.length} invalid, time=${validationElapsed}ms`);
            
            // Process validation results
            for (const fileInfo of filesToValidate) {
                const errorEntry = validationResults.errors.find(e => e.path === fileInfo.mediaPath);
                if (errorEntry) {
                    logMessage.warn(`[VALID] File failed validation: ${path.basename(fileInfo.mediaPath)} - ${errorEntry.error}`);
                    logMessage.info(`[VALID] Will re-download: ${path.basename(fileInfo.mediaPath)}`);
                    fileInfo.message._fileExist = false;
                    this.deleteInvalidFile(fileInfo.mediaPath);
                    batchSkippedExisting--;
                    skippedExisting--;
                    batchNewFiles++;
                    batchFilesToDownload++;
                }
            }
        }

        // Debug: Финальный лог статистики времени проверки
        if (checkedFiles > 0) {
            const checkTotalMs = Date.now() - checkStartedAt;
            const avgValidationMs = validationCount > 0 ? Math.round(validationTotalMs / validationCount) : 0;
            logMessage.dl(
                `[DL] Batch check summary: ${checkedFiles} files in ${checkTotalMs}ms. ` +
                `Validations: ${validationCount} (avg ${avgValidationMs}ms, total ${validationTotalMs}ms). ` +
                `Existence checks: ${checkExistTotalMs}ms. ` +
                `Skipped: ${batchSkippedExisting}, New: ${batchNewFiles}`
            );
        }
        
        // Финальный лог прогресса проверки
        if (checkedFiles > 0) {
            ProgressLogger.logCheckProgress(
                checkedFiles,
                messages.filter(m => m.media).length,
                batchSkippedExisting,
                batchNewFiles,
                checkStartedAt
            );
        }

        // Скачивание файлов
        logMessage.dl(`[DL] Second pass: starting downloads, ${batchFilesToDownload} new files`);
        for (const message of messages) {
            if (message.media) {
                const mediaType = getMediaType(message);
                const mediaPath = getMediaPath(message, outputFolder);
                const fileExist = message._fileExist !== undefined
                    ? message._fileExist
                    : checkFileExist(message, outputFolder, channelId);
                
                const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");

                const exclude = [/прямойэфир/, /рыночныйфон/, /ситуация по рынку/];
                const include = [/обуч/, /образ/];

                let textMatchesFilters = true;

                const shouldDownload = downloadableFiles[mediaType] ||
                                      downloadableFiles[mediaExtension] ||
                                      downloadableFiles["all"];

                logMessage.filter(`[FILTER] Download decision: msgId=${message.id}, type=${mediaType}, ext=${mediaExtension}, shouldDownload=${shouldDownload}, fileExist=${fileExist}`);

                if (shouldDownload && !fileExist && textMatchesFilters) {
                    logMessage.dl(`[DL] Queueing: msgId=${message.id}, file=${path.basename(mediaPath)}`);
                    
                    queuedDownloads++;
                    const downloadPromise = this.downloadMedia(
                        message,
                        mediaPath,
                        floodState,
                        channelId,
                        outputFolder
                    )
                    .then((result) => {
                        if (result.success) {
                            successfulDownloads++;
                            totalBytesDownloaded += result.fileSize;
                            addFileToCheckCache(mediaPath, result.fileSize);
                            logMessage.dl(`[DL] Download success: msgId=${message.id}, totalSuccess=${successfulDownloads}`);
                        } else {
                            failedDownloads++;
                            logMessage.dl(`[DL] Download failed: msgId=${message.id}, totalFailed=${failedDownloads}`);
                        }
                        
                        progressLogger.updateStats({
                            successful: successfulDownloads,
                            failed: failedDownloads,
                            active: this.activeDownloads.size
                        });
                        
                        if (progressLogger.shouldLogProgress()) {
                            progressLogger.logDownloadProgress();
                            progressLogger.markLogged();
                        }
                    })
                    .catch((err) => {
                        failedDownloads++;
                        logMessage.error(`[DL] Unhandled rejection for msgId=${message.id}: ${err?.message || err}`);
                    })
                    .finally(() => {
                        this.activeDownloads.delete(downloadPromise);
                    });
                    
                    this.activeDownloads.add(downloadPromise);
                } else {
                    if (fileExist) {
                        // already counted in skippedExisting
                    } else if (!textMatchesFilters) {
                        skippedByTextFilter++;
                    } else {
                        skippedByType++;
                    }
                }

                // Управление параллельностью
                if (this.activeDownloads.size >= floodState.getParallelLimit()) {
                    logMessage.dl(`[DL] Queue full (${floodState.getParallelLimit()}), waiting for free slot`);
                    await Promise.race(this.activeDownloads);
                }
            }
        }

        return {
            queuedDownloads,
            successfulDownloads,
            failedDownloads,
            skippedExisting,
            skippedByType,
            skippedByTextFilter,
            totalBytesDownloaded
        };
    }

    /**
     * Дождаться завершения всех загрузок
     */
    async waitForCompletion() {
        if (this.activeDownloads.size > 0) {
            logMessage.info(`[DL] Waiting for ${this.activeDownloads.size} remaining files...`);
            await Promise.all([...this.activeDownloads]);
            logMessage.success(`[DL] All downloads completed`);
        }
    }

    /**
     * Очистить ресурсы
     */
    cleanup() {
        logMessage.dl(`[DL] Cleanup: clearing file check cache`);
        clearFileCheckCache();
    }
}

/**
 * Скачать сообщения по ID
 */
const downloadMessagesByIds = async (client, channelId, messageIds, downloadableFiles = {}) => {
    try {
        logMessage.dl(`[DL] downloadMessagesByIds: channelId=${channelId}, ids=${JSON.stringify(messageIds)}`);
        const outputFolder = paths.getChannelExportPath(channelId);
        paths.ensureDir(outputFolder);
        
        db.initDatabase(channelId, outputFolder);

        const manager = new DownloadManager(client);
        const floodState = createFloodState();

        logMessage.dl(`[DL] Fetching messages by IDs: ${JSON.stringify(messageIds)}`);
        const messages = await manager.client.getMessages(channelId, { ids: messageIds });
        logMessage.dl(`[DL] getMessages returned ${messages.length} messages`);
        
        let activeDownloads = new Set();
        let totalFilesToDownload = 0;
        let queuedDownloads = 0;
        let successfulDownloads = 0;
        let failedDownloads = 0;
        let skippedExisting = 0;
        let totalBytesDownloaded = 0;
        
        const progressLogger = new ProgressLogger({
            maxParallel: floodState.getParallelLimit()
        });

        // Подсчет и проверка файлов
        logMessage.dl(`[DL] Checking ${messages.length} messages for media`);
        for (const message of messages) {
            if (message.media) {
                const mediaPath = getMediaPath(message, outputFolder);
                let fileExist = checkFileExist(message, outputFolder, channelId);
                
                if (!fileExist) {
                    totalFilesToDownload++;
                    logMessage.dl(`[DL] Need download: msgId=${message.id}, file=${path.basename(mediaPath)}`);
                } else {
                    skippedExisting++;
                    logMessage.cache(`[CACHE] File exists: ${path.basename(mediaPath)} (skipped)`);
                }
            }
        }

        // Скачивание
        logMessage.dl(`[DL] Starting downloads: ${totalFilesToDownload} new files`);
        for (const message of messages) {
            if (message.media) {
                const mediaPath = getMediaPath(message, outputFolder);
                const fileExist = checkFileExist(message, outputFolder, channelId);
                
                if (fileExist) {
                    logMessage.cache(`[CACHE] Skipping existing: msgId=${message.id}`);
                    continue;
                }
                
                queuedDownloads++;
                logMessage.dl(`[DL] Queueing: msgId=${message.id}, file=${path.basename(mediaPath)}`);
                
                const downloadPromise = manager.downloadMedia(
                    message,
                    mediaPath,
                    floodState,
                    channelId,
                    outputFolder
                )
                .then((result) => {
                    if (result.success) {
                        successfulDownloads++;
                        totalBytesDownloaded += result.fileSize;
                        addFileToCheckCache(mediaPath, result.fileSize);
                    } else {
                        failedDownloads++;
                    }
                });
                
                activeDownloads.add(downloadPromise);
            }
            
            if (activeDownloads.size >= floodState.getParallelLimit()) {
                logMessage.dl(`[DL] Queue full, waiting for free slot`);
                await Promise.race(activeDownloads);
            }
        }

        if (activeDownloads.size > 0) {
            logMessage.info("[DL] Waiting for files to be downloaded");
            await Promise.all([...activeDownloads]);
            logMessage.success("[DL] Files downloaded successfully");
        }
        
        logMessage.info(`[SUMMARY] Skipped existing: ${skippedExisting}`);
        
        manager.cleanup();
        
        return true;
    } catch (error) {
        logMessage.error(`[DL] Error downloading messages by IDs: ${error.message}`);
        return false;
    }
};

module.exports = {
    DownloadManager,
    downloadMessagesByIds,
    MAX_PARALLEL_DOWNLOAD
};
