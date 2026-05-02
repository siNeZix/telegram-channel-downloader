const PROGRESS_LOG_INTERVAL_SECONDS = 5;
const CHECK_PROGRESS_PERCENT_MILESTONES = [25, 50, 75, 100];

/** @type {Map<string, string>} последний залогированный снапшот по ключу проверки */
const _lastCheckLogSnapshot = new Map();
const CHECK_LOG_DEDUP_WINDOW_MS = 2000;

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

class ProgressLogger {
	constructor(options = {}) {
		this.downloadStartedAt = Date.now();
		this.lastProgressLogAt = 0;
		this.speedHistory = [];
		this.totalFiles = 0;
		this.successfulDownloads = 0;
		this.failedDownloads = 0;
		this.activeDownloads = 0;
		this.maxParallel = options.maxParallel || 20;
		this.channelId = options.channelId || null;
		this.totalBytesDownloaded = 0;
		this._lastMilestonePercent = 0;
		this._lastDownloadLogSnapshot = null;
	}

	logDownloadProgress() {
		const { logMessage } = require("../utils/helper");

		const finished = this.successfulDownloads + this.failedDownloads;
		const percent = this.totalFiles > 0 ? Math.round((finished * 100) / this.totalFiles) : 100;

		const elapsedSec = (Date.now() - this.downloadStartedAt) / 1000;
		const overallRate = elapsedSec > 0 ? finished / elapsedSec : 0;

		const now = Date.now();
		const tenSecondsAgo = now - 10000;

		while (this.speedHistory.length > 0 && this.speedHistory[0].timestamp < tenSecondsAgo) {
			this.speedHistory.shift();
		}

		this.speedHistory.push({
			timestamp: now,
			completed: finished,
			bytes: this.totalBytesDownloaded,
		});

		let recentRate = 0;
		let recentBytesRate = 0;
		if (this.speedHistory.length >= 2) {
			const firstPoint = this.speedHistory[0];
			const lastPoint = this.speedHistory[this.speedHistory.length - 1];
			const timeDiff = (lastPoint.timestamp - firstPoint.timestamp) / 1000;
			if (timeDiff > 0) {
				recentRate = (lastPoint.completed - firstPoint.completed) / timeDiff;
				recentBytesRate = (lastPoint.bytes - firstPoint.bytes) / timeDiff;
			}
		}

		const remaining = Math.max(0, this.totalFiles - finished);
		const eta =
			recentRate > 0
				? formatEta(remaining / recentRate)
				: overallRate > 0
					? formatEta(remaining / overallRate)
					: "unknown";

		const speedMBs = recentBytesRate / (1024 * 1024);
		const speedText =
			this.speedHistory.length >= 2
				? `${speedMBs.toFixed(2)} MB/s`
				: `${(this.totalBytesDownloaded / (1024 * 1024) / Math.max(elapsedSec, 1)).toFixed(2)} MB/s`;

		const parts = [
			`[DL] Download: ${finished}/${this.totalFiles} (${percent}%)`,
			`✓${this.successfulDownloads} ✗${this.failedDownloads}`,
			`queue: ${this.activeDownloads}/${this.maxParallel}`,
			`${speedText}`,
			`ETA: ${eta}`,
		];
		if (this.channelId) parts.push(`ch=${this.channelId}`);

		const line = parts.join(" | ");
		if (
			this._lastDownloadLogSnapshot &&
			this._lastDownloadLogSnapshot.line === line &&
			Date.now() - this._lastDownloadLogSnapshot.ts < 2000
		) {
			return;
		}
		this._lastDownloadLogSnapshot = { ts: Date.now(), line };

		logMessage.info(line);
	}

	shouldLogProgress() {
		const now = Date.now();
		const finished = this.successfulDownloads + this.failedDownloads;
		return finished === this.totalFiles || now - this.lastProgressLogAt >= PROGRESS_LOG_INTERVAL_SECONDS * 1000;
	}

	updateStats(stats = {}) {
		if (typeof stats.totalFiles === "number") this.totalFiles = stats.totalFiles;
		if (typeof stats.successful === "number") this.successfulDownloads = stats.successful;
		if (typeof stats.failed === "number") this.failedDownloads = stats.failed;
		if (typeof stats.active === "number") this.activeDownloads = stats.active;
		if (typeof stats.bytesDownloaded === "number") this.totalBytesDownloaded = stats.bytesDownloaded;
	}

	markLogged() {
		this.lastProgressLogAt = Date.now();
	}

	updateStats(stats = {}) {
		if (typeof stats.totalFiles === "number") this.totalFiles = stats.totalFiles;
		if (typeof stats.successful === "number") this.successfulDownloads = stats.successful;
		if (typeof stats.failed === "number") this.failedDownloads = stats.failed;
		if (typeof stats.active === "number") this.activeDownloads = stats.active;
		if (typeof stats.bytesDownloaded === "number") this.totalBytesDownloaded = stats.bytesDownloaded;
	}

	reset() {
		this.downloadStartedAt = Date.now();
		this.lastProgressLogAt = 0;
		this.speedHistory = [];
		this.totalFiles = 0;
		this.successfulDownloads = 0;
		this.failedDownloads = 0;
		this.activeDownloads = 0;
		this.totalBytesDownloaded = 0;
		this._lastMilestonePercent = 0;
	}

	static logCheckProgress(checked, total, skipped, newFiles, startedAt, channelId = null) {
		const { logMessage } = require("../utils/helper");

		const percent = total > 0 ? Math.round((checked * 100) / total) : 100;
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		const parts = [
			`[DL] Check: ${checked}/${total} (${percent}%)`,
			`skipped: ${skipped}, new: ${newFiles}`,
			`${elapsed}s`,
		];
		if (channelId) parts.push(`ch=${channelId}`);

		const line = parts.join(" | ");
		const dedupKey = `${channelId || "global"}::${total}::${skipped}::${newFiles}`;
		const last = _lastCheckLogSnapshot.get(dedupKey);
		if (last && Date.now() - last.ts < CHECK_LOG_DEDUP_WINDOW_MS && last.line === line) {
			return; // дубликат внутри окна
		}
		_lastCheckLogSnapshot.set(dedupKey, { ts: Date.now(), line });

		logMessage.info(line);
	}

	static shouldLogCheckProgress(checked, total, lastLogAt, intervalMs = 5000) {
		const now = Date.now();
		if (total <= 0) return false;

		if (checked === total) return true;

		const percent = Math.round((checked * 100) / total);
		for (const milestone of CHECK_PROGRESS_PERCENT_MILESTONES) {
			if (percent >= milestone && milestone > Math.round(((checked - 1) * 100) / total)) {
				return true;
			}
		}

		return now - lastLogAt >= intervalMs;
	}
}

module.exports = {
	ProgressLogger,
	formatEta,
	formatBytes,
	PROGRESS_LOG_INTERVAL_SECONDS,
};
