const fs = require("fs");
const {
	getMediaType,
	logMessage,
	wait,
	appendToJSONArrayFile,
	circularStringify,
	checkFileExist,
	getMediaPath,
} = require("../utils/helper");
const {
	getLastSelection,
	updateLastSelection,
} = require("../utils/file_helper");
const path = require("path");

const MAX_PARALLEL_DOWNLOAD = 20;
const MESSAGE_LIMIT = 200;

// Флаг для будущих текстовых фильтров. Сейчас они отключены,
// но логика оставлена в коде и может быть легко включена.
const ENABLE_TEXT_FILTERS = false;
const MIN_PARALLEL_DOWNLOAD = 2;
const BASE_RPC_DELAY_SECONDS = 0.15;
const MAX_RPC_RETRIES = 5;
const PROGRESS_LOG_INTERVAL_SECONDS = 5;
const FAST_FORWARD_MESSAGE_LIMIT = 1000;

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

const logDownloadProgress = (startedAt, queued, success, failed) => {
	const finished = success + failed;
	const percent =
		queued > 0 ? Math.round((finished * 100) / queued) : 100;
	const elapsedSec = (Date.now() - startedAt) / 1000;
	const rate = elapsedSec > 0 ? finished / elapsedSec : 0;
	const remaining = Math.max(0, queued - finished);
	const eta = rate > 0 ? formatEta(remaining / rate) : "unknown";
	logMessage.info(
		`Download progress: ${finished}/${queued} (${percent}%), failed: ${failed}, ETA: ${eta}`
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

const sleepWithFloodBuffer = async (seconds) => {
	const waitSeconds = Math.max(1, Math.ceil(seconds) + 2);
	logMessage.info(`Flood protection: sleeping ${waitSeconds}s before retry`);
	await wait(waitSeconds);
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
			`Flood cooldown active, waiting ${remainingSeconds}s before next API call`
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
					`Flood control: increased parallel limit to ${state.currentParallelLimit}`
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
					state.currentParallelLimit - 1
				);
				state.cooldownUntil = Date.now() + (floodSeconds + 2) * 1000;
				logMessage.error(
					`Flood detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit now ${state.currentParallelLimit}`
				);
				await sleepWithFloodBuffer(floodSeconds);
				continue;
			}
			throw err;
		}
	}
	throw new Error(
		`Exceeded retry limit (${MAX_RPC_RETRIES}) for ${label} due to flood protection`
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
						`../${message.id}_url.txt`
					);
					fs.writeFileSync(urlPath, url);
				}

				mediaPath = path.join(
					mediaPath,
					`../${message?.media?.webpage?.id}_image.jpeg`
				);
			}

			if (message.media.poll) {
				let pollPath = path.join(
					mediaPath,
					`../${message.id}_poll.json`
				);

				fs.writeFileSync(
					pollPath,
					circularStringify(message.media.poll, null, 2)
				);
			}

			await runWithFloodControl(floodState, "downloadMedia", async () => {
				return client.downloadMedia(message, {
					outputFile: mediaPath,
					progressCallback: (downloaded, total) => {
						const name = path.basename(mediaPath);
						if (total == downloaded) {
							logMessage.success(
								`file ${name} downloaded successfully`
							);
						}
					},
				});
			});

			return true;
		} else {
			return false;
		}
	} catch (err) {
		logMessage.error(
			`Error in downloadMessageMedia(): ${err?.message || String(err)}`
		);
		return false;
	}
};

const getMessages = async (client, channelId, downloadableFiles = {}) => {
	try {
		const floodState = createFloodState();
		let offsetId = messageOffsetId;
		let fastForwardMode = Number(lastKnownOffsetId) > 0;
		let outputFolder = path.join(__dirname, "../export/", `${channelId}`);
		let rawMessagePath = path.join(outputFolder, "raw_message.json");
		let messageFilePath = path.join(outputFolder, "all_message.json");
		let totalFetched = 0;
		let queuedDownloads = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		let skippedExisting = 0;
		let skippedByType = 0;
		let skippedByTextFilter = 0;
		const downloadStartedAt = Date.now();
		let lastProgressLogAt = 0;

		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder, { recursive: true });
		}

		while (true) {
			const inFastForwardRange =
				fastForwardMode &&
				(offsetId === 0 || offsetId > Number(lastKnownOffsetId));
			const messageLimit = inFastForwardRange
				? FAST_FORWARD_MESSAGE_LIMIT
				: MESSAGE_LIMIT;
			if (fastForwardMode && !inFastForwardRange) {
				logMessage.info(
					`Reached last known position (${lastKnownOffsetId}). Switching to normal batch size ${MESSAGE_LIMIT}`
				);
				fastForwardMode = false;
			}

			let allMessages = [];
			let messages = await runWithFloodControl(
				floodState,
				"getMessages",
				async () => {
					return client.getMessages(channelId, {
						limit: messageLimit,
						offsetId: offsetId,
					});
				}
			);
			totalFetched += messages.length;
			appendToJSONArrayFile(rawMessagePath, messages);
			logMessage.info(
				`getting messages (${totalFetched}/${
					messages.total
				}) : ${Math.round((totalFetched * 100) / messages.total)}%`
			);
			messages = messages.filter(
				(message) =>
					message.message != undefined || message.media != undefined
			);
			messages.forEach((message) => {
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
					`Done with all messages (${totalFetched}) 100%`
				);
				break;
			}

			let activeDownloads = new Set();
			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.media) {
					const mediaType = getMediaType(message);
					const mediaPath = getMediaPath(message, outputFolder);
					const fileExist = checkFileExist(message, outputFolder);

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
					if (
						shouldDownload &&
						!fileExist &&
						textMatchesFilters
					) {
						await wait(0.2);
						logMessage.info(
							`Start Downloading file ${mediaPath} (${mediaExtension}) `
						);
						queuedDownloads += 1;
						let downloadPromise;
						downloadPromise = downloadMessageMedia(
							client,
							message,
							mediaPath,
							floodState
						)
							.then((downloaded) => {
								if (downloaded) {
									successfulDownloads += 1;
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
										queuedDownloads,
										successfulDownloads,
										failedDownloads
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
										queuedDownloads,
										successfulDownloads,
										failedDownloads
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

					if (activeDownloads.size >= floodState.currentParallelLimit) {
						logMessage.debug(
							`Download queue is full (${floodState.currentParallelLimit}). Waiting for next free slot`
						);
						// Скользящее окно: ждём только один завершившийся файл, затем сразу продолжаем.
						await Promise.race(activeDownloads);
					}
				}
			}
			if (activeDownloads.size > 0) {
				logMessage.info("Waiting for files to be downloaded");
				await Promise.all([...activeDownloads]);
			}

			logMessage.success("Files downloaded successfully");
			logMessage.info(
				`Skip summary: existing=${skippedExisting}, byType=${skippedByType}, byTextFilter=${skippedByTextFilter}`
			);

			appendToJSONArrayFile(messageFilePath, allMessages);
			offsetId = messages[messages.length - 1].id;
			updateLastSelection({ messageOffsetId: offsetId });
			await wait(3);
		}

		return true;
	} catch (err) {
		logMessage.error(`Error in getMessages(): ${err?.message || String(err)}`);
	}
};

const getMessageDetail = async (client, channelId, messageIds) => {
	try {
		const floodState = createFloodState();
		const result = await runWithFloodControl(
			floodState,
			"getMessagesByIds",
			async () => {
				return client.getMessages(channelId, {
					ids: messageIds,
				});
			}
		);
		let outputFolder = `./export/${channelId}`;
		if (!fs.existsSync(outputFolder)) {
			fs.mkdirSync(outputFolder);
		}

		let activeDownloads = new Set();
		let queuedDownloads = 0;
		let successfulDownloads = 0;
		let failedDownloads = 0;
		const downloadStartedAt = Date.now();
		let lastProgressLogAt = 0;

		for (let i = 0; i < result.length; i++) {
			let message = result[i];
			if (message.media) {
				queuedDownloads += 1;
				let downloadPromise;
				downloadPromise = downloadMessageMedia(
					client,
					message,
					outputFolder,
					floodState
				)
					.then((downloaded) => {
						if (downloaded) {
							successfulDownloads += 1;
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
								queuedDownloads,
								successfulDownloads,
								failedDownloads
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
								queuedDownloads,
								successfulDownloads,
								failedDownloads
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
					`Download queue is full (${floodState.currentParallelLimit}). Waiting for next free slot`
				);
				await Promise.race(activeDownloads);
			}
		}

		if (activeDownloads.size > 0) {
			logMessage.info("Waiting for files to be downloaded");
			await Promise.all([...activeDownloads]);
			logMessage.success("Files downloaded successfully");
		}
		return true;
	} catch (err) {
		logMessage.error(
			`Error in getMessageDetail(): ${err?.message || String(err)}`
		);
	}
};

const sendMessage = async (client, channelId, message) => {
	try {
		let res = await client.sendMessage(channelId, { message });

		logMessage.success(`Message sent successfully with ID: ${res.id}`);
	} catch (err) {
		logMessage.error(`Error in sendMessage(): ${err?.message || String(err)}`);
	}
};

module.exports = {
	getMessages,
	getMessageDetail,
	sendMessage,
};
