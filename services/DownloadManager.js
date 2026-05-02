const fs = require("fs");
const path = require("path");
const db = require("../utils/db");
const paths = require("../utils/paths");
const config = require("../utils/config");
const {
	getMediaType,
	getExpectedMediaSize,
	getMediaPath,
	checkFileExist,
	addFileToCheckCache,
	clearFileCheckCache,
	fileCheckCache,
	logMessage,
	downloadState,
	initDownloadState,
} = require("../utils/helper");
const { createFloodState, isFileReferenceExpired: isFileRefExpired } = require("./FloodControl");
const { ProgressLogger } = require("./ProgressLogger");
const { TelegramEntityResolver } = require("./TelegramEntityResolver");
const { ValidationService } = require("./ValidationService");
const { hasEnoughDiskSpace } = require("../utils/paths");

const DEFAULT_DOWNLOAD_RETRY_ATTEMPTS = 3;
const DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS = 2;
const LARGE_FILE_RETRY_THRESHOLD_BYTES = 128 * 1024 * 1024;
const FILE_REF_EXPIRED_MAX_RETRIES = 3;

function isRetryableValidationError(error = "") {
	const normalized = String(error || "").toLowerCase();
	return (
		normalized.includes("size mismatch") ||
		normalized.includes("ffmpeg sampled decode") ||
		normalized.includes("ffprobe exit code") ||
		normalized.includes("no duration found") ||
		normalized.includes("invalid duration")
	);
}

function shouldRetryDownload(validationError, expectedSize, observedSize = null) {
	if (!isRetryableValidationError(validationError)) {
		return false;
	}

	if (
		String(validationError || "")
			.toLowerCase()
			.includes("size mismatch")
	) {
		return true;
	}

	return (
		(Number.isFinite(expectedSize) && expectedSize >= LARGE_FILE_RETRY_THRESHOLD_BYTES) ||
		(Number.isFinite(observedSize) && observedSize >= LARGE_FILE_RETRY_THRESHOLD_BYTES)
	);
}

/**
 * Сервис для управления загрузкой файлов
 */
const activeManagers = new Set();

class DownloadManager {
	constructor(client) {
		this.client = client;
		this.activeDownloads = new Set();
		this.activePartialPaths = new Set();
		this.entityResolver = new TelegramEntityResolver(client);
		activeManagers.add(this);
		logMessage.dl(`[DL] DownloadManager created, client type: ${typeof client}`);
	}

	removeFileIfExists(filePath, contextLabel = "file") {
		if (!filePath || !fs.existsSync(filePath)) {
			return;
		}

		try {
			fs.unlinkSync(filePath);
			logMessage.dl(`[DL] Removed ${contextLabel}: ${filePath}`);
		} catch (error) {
			logMessage.error(`[DL] Failed to remove ${contextLabel} ${filePath}: ${error.message}`);
		}
	}

	async performSingleDownloadAttempt(message, downloadTargetPath, finalValidationPath, floodState, msgId) {
		let fileSize = 0;

		this.removeFileIfExists(downloadTargetPath, "stale partial");

		logMessage.dl(`[DL] Starting Telegram download: msgId=${msgId}`);
		await floodState.runWithFloodControl(`downloadMedia-msg${msgId}`, async () => {
			return this.client.downloadMedia(message, {
				outputFile: downloadTargetPath,
				progressCallback: (downloaded, total) => {
					fileSize = downloaded;
					const name = path.basename(finalValidationPath);
					if (total === downloaded) {
						logMessage.dl(`[DL] Download complete: msgId=${msgId}, file=${name}, size=${fileSize}`);
					}
				},
			});
		});

		if (fs.existsSync(downloadTargetPath)) {
			fileSize = fs.statSync(downloadTargetPath).size;
			logMessage.dl(`[DL] File size from fs: msgId=${msgId}, size=${fileSize}`);
		}

		return fileSize;
	}

	/**
	 * Скачать медиа из сообщения
	 */
	async downloadMedia(message, mediaPath, floodState, channelId, outputFolder, ffmpegPaths, deepValidation) {
		const msgId = message?.id;
		const mediaType = message?.media ? getMediaType(message) : "none";
		const expectedSize = getExpectedMediaSize(message);
		const validationService = new ValidationService({
			channelId,
			outputFolder,
			ffmpegPaths,
		});
		const maxAttempts = Math.max(1, config.get("download.maxValidationRetries", DEFAULT_DOWNLOAD_RETRY_ATTEMPTS));
		const retryDelaySeconds = Math.max(
			0,
			config.get("download.retryDelaySeconds", DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS),
		);
		let partialPath = null;
		let finalValidationPath = mediaPath;
		let downloadTargetPath = null;
		let fileSize = 0;
		let validationResult = null;
		let lastValidationError = null;

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

			finalValidationPath = mediaPath;
			partialPath = validationService.getPartialPath(finalValidationPath);
			downloadTargetPath = partialPath;
			paths.ensureDir(path.dirname(downloadTargetPath));

			if (!hasEnoughDiskSpace(path.dirname(downloadTargetPath))) {
				logMessage.error(
					`[DL] ENOSPC guard: not enough free space to download msgId=${msgId} to ${path.dirname(downloadTargetPath)}`,
				);
				return { success: false, fileSize: 0, validationError: "ENOSPC: insufficient disk space" };
			}

			this.removeFileIfExists(downloadTargetPath, "stale partial");
			this.removeFileIfExists(finalValidationPath, "stale target");
			this.activePartialPaths.add(downloadTargetPath);

			// Обработка poll
			if (message.media.poll) {
				let pollPath = path.join(mediaPath, `../${message.id}_poll.json`);
				const { circularStringify } = require("../utils/helper");
				logMessage.dl(`[DL] Saving poll data for msgId=${msgId}`);
				fs.writeFileSync(pollPath, circularStringify(message.media.poll, null, 2));
			}

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				fileSize = await this.performSingleDownloadAttempt(
					message,
					downloadTargetPath,
					finalValidationPath,
					floodState,
					msgId,
				);
				validationResult = await validationService.validateMediaFile(downloadTargetPath, mediaType, {
					deepValidation,
					expectedSize,
				});

				if (validationResult.valid) {
					break;
				}

				lastValidationError = validationResult.error;
				this.removeFileIfExists(downloadTargetPath, "invalid partial");

				if (attempt >= maxAttempts || !shouldRetryDownload(validationResult.error, expectedSize, fileSize)) {
					break;
				}

				logMessage.warn(
					`[DL] Retrying download for msgId=${msgId} after validation failure ` +
						`(${attempt}/${maxAttempts}): ${validationResult.error}`,
				);

				if (retryDelaySeconds > 0) {
					await floodState.waitFn(retryDelaySeconds);
				}
			}

			if (!validationResult?.valid) {
				this.activePartialPaths.delete(downloadTargetPath);
				this.removeFileIfExists(downloadTargetPath, "invalid partial");
				this.removeFileIfExists(finalValidationPath, "invalid target");

				if (channelId && outputFolder) {
					db.setFileDownloaded(channelId, outputFolder, message.id, 0);
					db.setValidationState(channelId, outputFolder, message.id, {
						status: "failed",
						profile: validationResult?.profile || "none",
						error: lastValidationError || validationResult?.error || "download validation failed",
					});
				}

				fileCheckCache.delete(finalValidationPath);
				return {
					success: false,
					fileSize: 0,
					validationError: lastValidationError || validationResult?.error || "download validation failed",
				};
			}

			fileSize = validationService.finalizeValidatedDownload(downloadTargetPath, finalValidationPath);
			this.activePartialPaths.delete(downloadTargetPath);

			// Отмечаем файл как скачанный в БД
			if (channelId && outputFolder) {
				db.setFileDownloaded(channelId, outputFolder, message.id, 1);
				db.setValidationState(channelId, outputFolder, message.id, {
					status: "verified",
					profile: validationResult.profile,
					error: null,
				});
				downloadState.markDownloaded(message.id);
				logMessage.dl(`[DL] Marked downloaded in DB: msgId=${msgId}, channelId=${channelId}`);
			}

			return { success: true, fileSize, validationProfile: validationResult.profile };
		} catch (err) {
			const fileRefExpiredFlag = err?._isFileReferenceExpired || isFileRefExpired(err);
			if (fileRefExpiredFlag && channelId && this.entityResolver) {
				logMessage.warn(`[DL] FILE_REFERENCE_EXPIRED for msgId=${msgId}, will re-fetch message and retry`);
				let refreshedMessage = null;
				for (let refetchAttempt = 1; refetchAttempt <= FILE_REF_EXPIRED_MAX_RETRIES; refetchAttempt++) {
					try {
						const inputPeer = await this.entityResolver.resolve(channelId);
						const freshMessages = await floodState.runWithFloodControl(
							`refetchMessage-msg${msgId}`,
							async () => this.client.getMessages(inputPeer, { ids: [msgId] }),
						);
						if (freshMessages && freshMessages.length > 0 && freshMessages[0]?.media) {
							refreshedMessage = freshMessages[0];
							logMessage.warn(
								`[DL] Re-fetched message msgId=${msgId} (attempt ${refetchAttempt}), retrying download`,
							);
							try {
								for (let attempt = 1; attempt <= maxAttempts; attempt++) {
									fileSize = await this.performSingleDownloadAttempt(
										refreshedMessage,
										downloadTargetPath,
										finalValidationPath,
										floodState,
										msgId,
									);
									validationResult = await validationService.validateMediaFile(
										downloadTargetPath,
										mediaType,
										{
											deepValidation,
											expectedSize,
										},
									);

									if (validationResult.valid) {
										break;
									}

									lastValidationError = validationResult.error;
									this.removeFileIfExists(downloadTargetPath, "invalid partial after refetch");

									if (
										attempt >= maxAttempts ||
										!shouldRetryDownload(validationResult.error, expectedSize, fileSize)
									) {
										break;
									}

									logMessage.warn(
										`[DL] Retrying download (after refetch) for msgId=${msgId} after validation failure ` +
											`(${attempt}/${maxAttempts}): ${validationResult.error}`,
									);

									if (retryDelaySeconds > 0) {
										await floodState.waitFn(retryDelaySeconds);
									}
								}

								if (validationResult?.valid) {
									fileSize = validationService.finalizeValidatedDownload(
										downloadTargetPath,
										finalValidationPath,
									);
									this.activePartialPaths.delete(downloadTargetPath);

									if (channelId && outputFolder) {
										db.setFileDownloaded(channelId, outputFolder, refreshedMessage.id, 1);
										db.setValidationState(channelId, outputFolder, refreshedMessage.id, {
											status: "verified",
											profile: validationResult.profile,
											error: null,
										});
										downloadState.markDownloaded(refreshedMessage.id);
										logMessage.dl(
											`[DL] Marked downloaded in DB (after refetch): msgId=${msgId}, channelId=${channelId}`,
										);
									}

									return { success: true, fileSize, validationProfile: validationResult.profile };
								} else {
									logMessage.warn(
										`[DL] Download for msgId=${msgId} failed validation after refetch, giving up`,
									);
								}
							} catch (retryErr) {
								const retryFileRefExpiredFlag =
									retryErr?._isFileReferenceExpired || isFileRefExpired(retryErr);
								if (retryFileRefExpiredFlag && refetchAttempt < FILE_REF_EXPIRED_MAX_RETRIES) {
									logMessage.warn(
										`[DL] FILE_REFERENCE_EXPIRED again for msgId=${msgId} after refetch attempt ${refetchAttempt}`,
									);
									continue;
								}
								logMessage.error(
									`[DL] Download failed (after refetch) for msgId=${msgId}: ${retryErr?.message || String(retryErr)}`,
								);
								break;
							}
						} else {
							logMessage.warn(
								`[DL] Re-fetched message msgId=${msgId} but no media found (attempt ${refetchAttempt})`,
							);
						}
					} catch (refetchErr) {
						logMessage.error(
							`[DL] Failed to re-fetch message msgId=${msgId} (attempt ${refetchAttempt}): ${refetchErr?.message || String(refetchErr)}`,
						);
					}
				}
			}

			logMessage.error(`[DL] Error in downloadMedia: msgId=${msgId}, error=${err?.message || String(err)}`);
			const cleanupPath = downloadTargetPath || partialPath;
			if (cleanupPath) {
				this.activePartialPaths.delete(cleanupPath);
			}
			if (cleanupPath && fs.existsSync(cleanupPath)) {
				try {
					fs.unlinkSync(cleanupPath);
				} catch (cleanupError) {
					logMessage.error(`[DL] Failed to remove partial file ${cleanupPath}: ${cleanupError.message}`);
				}
			}
			return { success: false, fileSize: 0 };
		}
	}

	/**
	 * Проверить файл на валидность
	 */
	async validateMediaFile(mediaPath, mediaType, ffmpegPaths, deepValidation, expectedSize = null) {
		try {
			const validationService = new ValidationService({ ffmpegPaths });
			const validationStart = Date.now();
			const validationResult = await validationService.validateMediaFile(mediaPath, mediaType, {
				deepValidation,
				expectedSize,
			});
			const validationMs = Date.now() - validationStart;

			if (validationResult.valid) {
				logMessage.valid(
					`[VALID] Valid: ${path.basename(mediaPath)} (${validationMs}ms, profile=${validationResult.profile})`,
				);
			} else {
				logMessage.valid(
					`[VALID] Invalid: ${path.basename(mediaPath)} - ${validationResult.error} (${validationMs}ms, profile=${validationResult.profile})`,
				);
			}

			return validationResult;
		} catch (err) {
			logMessage.error(`[VALID] Error validating file ${mediaPath}: ${err.message}`);
			return { valid: false, error: err.message };
		}
	}

	/**
	 * Удалить невалидный файл
	 */
	async deleteInvalidFile(mediaPath, channelId, outputFolder, ffmpegPaths) {
		try {
			const validationService = new ValidationService({ channelId, outputFolder, ffmpegPaths });
			if (fs.existsSync(mediaPath)) {
				if (config.get("download.quarantineInvalidFiles", true)) {
					const quarantineResult = await validationService.quarantineFile(
						mediaPath,
						"existing file validation failed",
						{
							channelId,
							originalTargetPath: mediaPath,
						},
					);
					if (!quarantineResult?.ok) {
						return false;
					}
				} else {
					fs.unlinkSync(mediaPath);
				}
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
		const { outputFolder, channelId, ffmpegPaths, deepValidation, floodState, downloadableFiles } = context;

		logMessage.dl(`[DL] processMessageBatch: channelId=${channelId}, messageCount=${messages.length}`);

		// Подсчет файлов для скачивания
		let batchFilesToDownload = 0;
		let batchSkippedExisting = 0;
		let batchNewFiles = 0;
		const checkStartedAt = Date.now();
		let lastCheckProgressLogAt = 0;
		let checkedFiles = 0;
		let checkExistTotalMs = 0;
		let validationCount = 0;
		let validationTotalMs = 0;

		let queuedDownloads = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		let skippedExisting = 0;
		let skippedByType = 0;
		let skippedByTextFilter = 0;
		let totalBytesDownloaded = 0;

		const progressLogger = new ProgressLogger({ maxParallel: floodState.getParallelLimit() });

		const batchChannelId = channelId;
		const batchOutputFolder = outputFolder;
		const batchFFmpegPaths = ffmpegPaths;
		const batchDeepValidation = deepValidation;

		// First pass: check file existence (fast operation)
		const filesToValidate = [];

		logMessage.dl(`[DL] First pass: checking ${messages.length} messages for media`);
		for (const message of messages) {
			if (message.media) {
				const mediaType = getMediaType(message);
				const mediaPath = getMediaPath(message, outputFolder);
				const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");
				const shouldDownload =
					downloadableFiles[mediaType] || downloadableFiles[mediaExtension] || downloadableFiles["all"];

				if (shouldDownload) {
					const fileExistStart = Date.now();
					let fileExist = checkFileExist(message, outputFolder, channelId);
					const fileExistEnd = Date.now();
					checkExistTotalMs += fileExistEnd - fileExistStart;

					message._fileExist = fileExist;
					message._mediaPath = mediaPath;
					message._mediaType = mediaType;
					checkedFiles++;

					if (fileExist) {
						// Validate only files that physically exist on disk.
						// Snapshot entries may represent intentionally removed files.
						if (ffmpegPaths && !message._fromSnapshot && fs.existsSync(mediaPath)) {
							filesToValidate.push({
								message,
								mediaPath,
								mediaType,
							});
						}
						batchSkippedExisting++;
						skippedExisting++;
						logMessage.cache(`[CACHE] File exists (skipped): ${path.basename(mediaPath)}`);
					} else {
						batchNewFiles++;
						batchFilesToDownload++;
						logMessage.dl(
							`[DL] Need download: msgId=${message.id}, type=${mediaType}, file=${path.basename(mediaPath)}`,
						);
					}

					if (
						ProgressLogger.shouldLogCheckProgress(
							checkedFiles,
							messages.filter((m) => m.media).length,
							lastCheckProgressLogAt,
						)
					) {
						ProgressLogger.logCheckProgress(
							checkedFiles,
							messages.filter((m) => m.media).length,
							batchSkippedExisting,
							batchNewFiles,
							checkStartedAt,
							channelId,
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
			const ffmpegBin = ffmpegPaths.ffmpeg;
			const ffprobeBin = ffmpegPaths.ffprobe;
			const maxParallelValidation = Math.min(10, floodState.getParallelLimit());
			const validationService = new ValidationService({ channelId, outputFolder, ffmpegPaths });

			logMessage.valid(
				`[VALID] Starting parallel validation: count=${filesToValidate.length}, maxParallel=${maxParallelValidation}`,
			);

			const validationStart = Date.now();
			const validationResults = { errors: [] };
			let fileIndex = 0;
			const worker = async () => {
				while (fileIndex < filesToValidate.length) {
					const currentIndex = fileIndex++;
					if (currentIndex >= filesToValidate.length) {
						break;
					}

					const fileInfo = filesToValidate[currentIndex];
					const result = await validationService.validateMediaFile(fileInfo.mediaPath, fileInfo.mediaType, {
						deepValidation,
						expectedSize: getExpectedMediaSize(fileInfo.message),
					});
					logMessage.valid(
						`[VALID] Result: ${path.basename(fileInfo.mediaPath)} = ${result.valid ? "valid" : "invalid"}: ${result.error || ""}`,
					);
					validationCount++;
					if (!result.valid) {
						validationResults.errors.push({ path: fileInfo.mediaPath, error: result.error });
					}
				}
			};
			const workers = [];
			for (let i = 0; i < Math.min(maxParallelValidation, filesToValidate.length); i++) {
				workers.push(worker());
			}
			await Promise.all(workers);
			const validationElapsed = Date.now() - validationStart;
			validationTotalMs += validationElapsed;
			logMessage.valid(
				`[VALID] Parallel validation complete: ${validationResults.errors.length} invalid, time=${validationElapsed}ms`,
			);

			// Process validation results
			for (const fileInfo of filesToValidate) {
				const errorEntry = validationResults.errors.find((e) => e.path === fileInfo.mediaPath);
				if (errorEntry) {
					logMessage.warn(
						`[VALID] File failed validation: ${path.basename(fileInfo.mediaPath)} - ${errorEntry.error}`,
					);
					logMessage.info(`[VALID] Will re-download: ${path.basename(fileInfo.mediaPath)}`);
					fileInfo.message._fileExist = false;
					await this.deleteInvalidFile(fileInfo.mediaPath, channelId, outputFolder, ffmpegPaths);
					if (channelId && outputFolder) {
						db.setFileDownloaded(channelId, outputFolder, fileInfo.message.id, 0);
						db.setValidationState(channelId, outputFolder, fileInfo.message.id, {
							status: config.get("download.quarantineInvalidFiles", true) ? "quarantined" : "failed",
							profile: deepValidation ? "full" : config.get("download.validationProfile", "sampled"),
							error: errorEntry.error,
						});
					}
					batchSkippedExisting--;
					skippedExisting--;
					batchNewFiles++;
					batchFilesToDownload++;
				}
			}
		}

		progressLogger.updateStats({ totalFiles: batchFilesToDownload });

		// Debug: Финальный лог статистики времени проверки
		if (checkedFiles > 0) {
			const checkTotalMs = Date.now() - checkStartedAt;
			const avgValidationMs = validationCount > 0 ? Math.round(validationTotalMs / validationCount) : 0;
			logMessage.dl(
				`[DL] Batch check summary: ${checkedFiles} files in ${checkTotalMs}ms. ` +
					`Validations: ${validationCount} (avg ${avgValidationMs}ms, total ${validationTotalMs}ms). ` +
					`Existence checks: ${checkExistTotalMs}ms. ` +
					`Skipped: ${batchSkippedExisting}, New: ${batchNewFiles}`,
			);
		}

		if (checkedFiles > 0) {
			const mediaCount = messages.filter((m) => m.media).length;
			ProgressLogger.logCheckProgress(
				mediaCount,
				mediaCount,
				batchSkippedExisting,
				batchNewFiles,
				checkStartedAt,
				channelId,
			);
		}

		// Скачивание файлов
		logMessage.dl(`[DL] Second pass: starting downloads, ${batchFilesToDownload} new files`);
		for (const message of messages) {
			if (message.media) {
				const mediaType = getMediaType(message);
				const mediaPath = getMediaPath(message, outputFolder);
				const fileExist =
					message._fileExist !== undefined
						? message._fileExist
						: checkFileExist(message, outputFolder, channelId);

				const mediaExtension = path.extname(mediaPath)?.toLowerCase()?.replace(".", "");

				const shouldDownload =
					downloadableFiles[mediaType] || downloadableFiles[mediaExtension] || downloadableFiles["all"];

				logMessage.filter(
					`[FILTER] Download decision: msgId=${message.id}, type=${mediaType}, ext=${mediaExtension}, shouldDownload=${shouldDownload}, fileExist=${fileExist}`,
				);

				if (shouldDownload && !fileExist) {
					logMessage.dl(`[DL] Queueing: msgId=${message.id}, file=${path.basename(mediaPath)}`);

					queuedDownloads++;
					const downloadPromise = this.downloadMedia(
						message,
						mediaPath,
						floodState,
						channelId,
						outputFolder,
						batchFFmpegPaths,
						batchDeepValidation,
					)
						.then((result) => {
							if (result.success) {
								successfulDownloads++;
								totalBytesDownloaded += result.fileSize;
								addFileToCheckCache(mediaPath, result.fileSize);
								logMessage.dl(
									`[DL] Download success: msgId=${message.id}, totalSuccess=${successfulDownloads}, profile=${result.validationProfile || "none"}`,
								);
							} else {
								failedDownloads++;
								logMessage.dl(
									`[DL] Download failed: msgId=${message.id}, totalFailed=${failedDownloads}, reason=${result.validationError || "download error"}`,
								);
							}

							progressLogger.updateStats({
								successful: successfulDownloads,
								failed: failedDownloads,
								active: this.activeDownloads.size,
								bytesDownloaded: totalBytesDownloaded,
							});

							if (progressLogger.shouldLogProgress()) {
								progressLogger.logDownloadProgress();
								progressLogger.markLogged();
							}
						})
						.catch((err) => {
							failedDownloads++;
							logMessage.error(
								`[DL] Unhandled rejection for msgId=${message.id}: ${err?.message || err}`,
							);
						})
						.finally(() => {
							this.activeDownloads.delete(downloadPromise);
						});

					this.activeDownloads.add(downloadPromise);
				} else {
					if (fileExist) {
						if (!message._fromSnapshot && ffmpegPaths && channelId && outputFolder) {
							db.setValidationState(channelId, outputFolder, message.id, {
								status: "verified",
								profile: deepValidation ? "full" : config.get("download.validationProfile", "sampled"),
								error: null,
							});
						}
						logMessage.cache(`[CACHE] Keeping verified existing file: msgId=${message.id}`);
					} else {
						skippedByType++;
					}
				}

				// Управление параллельностью
				if (this.activeDownloads.size >= floodState.getParallelLimit()) {
					logMessage.dl(`[DL] Queue full (${floodState.getParallelLimit()}), waiting for free slot`);
					if (this.activeDownloads.size > 0) {
						try {
							await Promise.race(this.activeDownloads);
						} catch (err) {
							logMessage.error(`[DL] Download slot promise rejected: ${err?.message || err}`);
						}
					}
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
			totalBytesDownloaded,
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

	cancel() {
		this._cancelled = true;
		const pending = this.activePartialPaths.size;
		if (pending > 0) {
			logMessage.warn(`[DL] Cancelling: cleaning ${pending} partial file(s)`);
		}
		for (const partialPath of this.activePartialPaths) {
			try {
				if (fs.existsSync(partialPath)) {
					fs.unlinkSync(partialPath);
					logMessage.dl(`[DL] Removed partial on cancel: ${path.basename(partialPath)}`);
				}
			} catch (e) {
				logMessage.error(`[DL] Failed to remove partial on cancel: ${partialPath}: ${e.message}`);
			}
		}
		this.activePartialPaths.clear();
	}

	cleanup() {
		logMessage.dl(`[DL] Cleanup: clearing file check cache`);
		for (const partialPath of this.activePartialPaths) {
			try {
				if (fs.existsSync(partialPath)) {
					fs.unlinkSync(partialPath);
				}
			} catch (e) {
				/* best effort on cleanup */
			}
		}
		this.activePartialPaths.clear();
		clearFileCheckCache();
		activeManagers.delete(this);
	}
}

/**
 * Скачать сообщения по ID
 */
const downloadMessagesByIds = async (client, channelId, messageIds, downloadableFiles = {}, options = {}) => {
	try {
		logMessage.dl(`[DL] downloadMessagesByIds: channelId=${channelId}, ids=${JSON.stringify(messageIds)}`);
		const outputFolder = options.outputFolder || paths.getChannelExportPath(channelId);
		paths.ensureDir(outputFolder);

		db.initDatabase(channelId, outputFolder);
		initDownloadState(channelId, outputFolder);

		const manager = new DownloadManager(client);
		const floodState = createFloodState();
		manager.channelId = channelId;
		manager.outputFolder = outputFolder;
		manager.deepValidation = !!options.deepValidation;
		manager.ffmpegPaths = options.ffmpegPaths || null;

		logMessage.dl(`[DL] Fetching messages by IDs: ${JSON.stringify(messageIds)}`);
		const inputPeer = await manager.entityResolver.resolve(channelId);
		const messages = await manager.client.getMessages(inputPeer, { ids: messageIds });
		logMessage.dl(`[DL] getMessages returned ${messages.length} messages`);

		let totalFilesToDownload = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		let skippedExisting = 0;
		let totalBytesDownloaded = 0;

		const progressLogger = new ProgressLogger({
			maxParallel: floodState.getParallelLimit(),
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

				logMessage.dl(`[DL] Queueing: msgId=${message.id}, file=${path.basename(mediaPath)}`);

				const downloadPromise = manager
					.downloadMedia(message, mediaPath, floodState, channelId, outputFolder)
					.then((result) => {
						if (result.success) {
							successfulDownloads++;
							totalBytesDownloaded += result.fileSize;
							addFileToCheckCache(mediaPath, result.fileSize);
						} else {
							failedDownloads++;
						}
					})
					.finally(() => {
						manager.activeDownloads.delete(downloadPromise);
					});

				manager.activeDownloads.add(downloadPromise);
			}

			if (manager.activeDownloads.size >= floodState.getParallelLimit()) {
				logMessage.dl(`[DL] Queue full, waiting for free slot`);
				if (manager.activeDownloads.size > 0) {
					try {
						await Promise.race(manager.activeDownloads);
					} catch (err) {
						logMessage.error(`[DL] Download slot promise rejected: ${err?.message || err}`);
					}
				}
			}
		}

		if (manager.activeDownloads.size > 0) {
			logMessage.info("[DL] Waiting for files to be downloaded");
			await Promise.all([...manager.activeDownloads]);
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

function cancelAllDownloads() {
	let totalCleaned = 0;
	for (const manager of activeManagers) {
		const size = manager.activePartialPaths.size;
		manager.cancel();
		totalCleaned += size;
	}
	if (totalCleaned > 0) {
		const loggerSync = require("../utils/logger");
		loggerSync.writeSync("info", `[DL] Cleaned ${totalCleaned} partial file(s) across all managers`);
	}
}

module.exports = {
	DownloadManager,
	downloadMessagesByIds,
	isRetryableValidationError,
	shouldRetryDownload,
	cancelAllDownloads,
};
