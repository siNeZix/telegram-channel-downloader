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
    }

    /**
     * Скачать медиа из сообщения
     */
    async downloadMedia(message, mediaPath, floodState, channelId, outputFolder) {
        try {
            if (!message.media) {
                return { success: false, fileSize: 0 };
            }

            // Обработка webpage
            if (message.media.webpage) {
                let url = message.media.webpage.url;
                if (url) {
                    let urlPath = path.join(mediaPath, `../${message.id}_url.txt`);
                    fs.writeFileSync(urlPath, url);
                }
                mediaPath = path.join(mediaPath, `../${message?.media?.webpage?.id}_image.jpeg`);
            }

            // Обработка poll
            if (message.media.poll) {
                let pollPath = path.join(mediaPath, `../${message.id}_poll.json`);
                const { circularStringify } = require("../utils/helper");
                fs.writeFileSync(pollPath, circularStringify(message.media.poll, null, 2));
            }

            let fileSize = 0;
            
            await floodState.runWithFloodControl("downloadMedia", async () => {
                return this.client.downloadMedia(message, {
                    outputFile: mediaPath,
                    progressCallback: (downloaded, total) => {
                        fileSize = downloaded;
                        const name = path.basename(mediaPath);
                        if (total == downloaded) {
                            logMessage.success(`file ${name} downloaded successfully`);
                        }
                    },
                });
            });

            // Если fileSize не обновился, получаем размер файла из файловой системы
            if (fileSize === 0 && fs.existsSync(mediaPath)) {
                fileSize = fs.statSync(mediaPath).size;
            }

            // Отмечаем файл как скачанный в БД
            if (channelId && outputFolder) {
                db.setFileDownloaded(channelId, outputFolder, message.id, 1);
            }

            return { success: true, fileSize };
        } catch (err) {
            logMessage.error(`Error in downloadMessageMedia(): ${err?.message || String(err)}`);
            return { success: false, fileSize: 0 };
        }
    }

    /**
     * Проверить файл на валидность
     */
    async validateMediaFile(mediaPath, mediaType, ffmpegPaths, deepValidation) {
        if (!ffmpegPaths) return true;
        
        try {
            const fileType = mediaType.toLowerCase().includes("video") ? "video" : "image";
            const validationResult = await validateFile(
                mediaPath,
                fileType,
                ffmpegPaths.ffmpeg,
                ffmpegPaths.ffprobe,
                deepValidation
            );
            
            return validationResult;
        } catch (err) {
            logMessage.error(`Error validating file ${mediaPath}: ${err.message}`);
            return { valid: true }; // На всякий случай считаем файл валидным
        }
    }

    /**
     * Удалить невалидный файл
     */
    deleteInvalidFile(mediaPath) {
        try {
            if (fs.existsSync(mediaPath)) {
                fs.unlinkSync(mediaPath);
            }
            fileCheckCache.delete(mediaPath);
            return true;
        } catch (e) {
            logMessage.error(`Failed to delete invalid file: ${e.message}`);
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

        // Проверяем файлы
        for (const message of messages) {
            if (message.media) {
                const mediaType = getMediaType(message);
                const mediaPath = getMediaPath(message, outputFolder);
                const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");
                const shouldDownload = downloadableFiles[mediaType] ||
                                      downloadableFiles[mediaExtension] ||
                                      downloadableFiles["all"];
                
                if (shouldDownload) {
                    let fileExist = checkFileExist(message, outputFolder, channelId);

                    // Валидация
                    if (fileExist && ffmpegPaths) {
                        const validationResult = await this.validateMediaFile(
                            mediaPath,
                            mediaType,
                            ffmpegPaths,
                            deepValidation
                        );

                        if (!validationResult.valid) {
                            logMessage.warn(`File failed validation: ${path.basename(mediaPath)} - ${validationResult.error}`);
                            logMessage.info(`Will re-download: ${path.basename(mediaPath)}`);
                            fileExist = false;
                            this.deleteInvalidFile(mediaPath);
                        }
                    }

                    message._fileExist = fileExist;
                    checkedFiles++;

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

                    if (fileExist) {
                        batchSkippedExisting++;
                        skippedExisting++;
                        logMessage.debug(`File exists: ${path.basename(mediaPath)} (skipped)`);
                    } else {
                        batchNewFiles++;
                        batchFilesToDownload++;
                    }
                }
            }
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

                if (shouldDownload && !fileExist && textMatchesFilters) {
                    await wait(0.2);
                    logMessage.info(`Start Downloading file ${mediaPath} (${mediaExtension})`);
                    
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
                        } else {
                            failedDownloads++;
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
                    .catch(() => {
                        failedDownloads++;
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
                    logMessage.debug(`Download queue is full (${floodState.getParallelLimit()}). Waiting for next free slot`);
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
            logMessage.info(`Waiting for ${this.activeDownloads.size} remaining files to be downloaded...`);
            await Promise.all([...this.activeDownloads]);
        }
    }

    /**
     * Очистить ресурсы
     */
    cleanup() {
        clearFileCheckCache();
    }
}

/**
 * Скачать сообщения по ID
 */
const downloadMessagesByIds = async (client, channelId, messageIds, downloadableFiles = {}) => {
    try {
        const outputFolder = paths.getChannelExportPath(channelId);
        paths.ensureDir(outputFolder);
        
        db.initDatabase(channelId, outputFolder);

        const manager = new DownloadManager(client);
        const floodState = createFloodState();

        const messages = await manager.client.getMessages(channelId, { ids: messageIds });
        
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
        for (const message of messages) {
            if (message.media) {
                const mediaPath = getMediaPath(message, outputFolder);
                let fileExist = checkFileExist(message, outputFolder, channelId);
                
                if (!fileExist) {
                    totalFilesToDownload++;
                } else {
                    skippedExisting++;
                    logMessage.debug(`File exists: ${path.basename(mediaPath)} (skipped)`);
                }
            }
        }

        // Скачивание
        for (const message of messages) {
            if (message.media) {
                const mediaPath = getMediaPath(message, outputFolder);
                const fileExist = checkFileExist(message, outputFolder, channelId);
                
                if (fileExist) continue;
                
                queuedDownloads++;
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
                await Promise.race(activeDownloads);
            }
        }

        if (activeDownloads.size > 0) {
            logMessage.info("Waiting for files to be downloaded");
            await Promise.all([...activeDownloads]);
            logMessage.success("Files downloaded successfully");
        }
        
        logMessage.info(`Skip summary: existing=${skippedExisting}`);
        
        manager.cleanup();
        
        return true;
    } catch (error) {
        logMessage.error(`Error downloading messages by IDs: ${error.message}`);
        return false;
    }
};

module.exports = {
    DownloadManager,
    downloadMessagesByIds,
    MAX_PARALLEL_DOWNLOAD
};
