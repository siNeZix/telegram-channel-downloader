const PROGRESS_LOG_INTERVAL_SECONDS = 5;

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

/**
 * Сервис для логирования прогресса загрузки
 */
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
    }

    /**
     * Обновить статистику
     */
    updateStats(stats) {
        if (stats.totalFiles !== undefined) this.totalFiles = stats.totalFiles;
        if (stats.successful !== undefined) this.successfulDownloads = stats.successful;
        if (stats.failed !== undefined) this.failedDownloads = stats.failed;
        if (stats.active !== undefined) this.activeDownloads = stats.active;
    }

    /**
     * Рассчитать и залогировать прогресс загрузки
     */
    logDownloadProgress() {
        const { logMessage } = require('../utils/helper');
        
        const finished = this.successfulDownloads + this.failedDownloads;
        const percent = this.totalFiles > 0 ? Math.round((finished * 100) / this.totalFiles) : 100;

        // Средняя скорость за всё время
        const elapsedSec = (Date.now() - this.downloadStartedAt) / 1000;
        const overallRate = elapsedSec > 0 ? finished / elapsedSec : 0;

        // Средняя скорость за последние 10 секунд (в МБ/с)
        const now = Date.now();
        const tenSecondsAgo = now - 10000;

        // Удаляем старые записи
        while (
            this.speedHistory.length > 0 &&
            this.speedHistory[0].timestamp < tenSecondsAgo
        ) {
            this.speedHistory.shift();
        }

        // Добавляем текущую точку
        this.speedHistory.push({
            timestamp: now,
            completed: finished,
            bytes: 0, // Will be set by caller
        });

        // Рассчитываем скорость за последние 10 секунд
        let recentRate = 0; // файлов/с
        let recentBytesRate = 0; // байт/с
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
        const eta = recentRate > 0
            ? formatEta(remaining / recentRate)
            : overallRate > 0
                ? formatEta(remaining / overallRate)
                : "unknown";

        const speedMBs = recentBytesRate / (1024 * 1024);
        const speedText = this.speedHistory.length >= 2
            ? `${speedMBs.toFixed(2)} MB/s (avg 10s)`
            : `${(recentBytesRate / (1024 * 1024) / Math.max(elapsedSec, 1)).toFixed(2)} MB/s (overall)`;

        // Добавляем временную метку и состояние очереди
        const timestamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
        logMessage.info(
            `[${timestamp}] [Queue: ${this.activeDownloads}/${this.maxParallel}] Download progress: ${finished}/${this.totalFiles} (${percent}%), failed: ${this.failedDownloads}, speed: ${speedText}, ETA: ${eta}`
        );
    }

    /**
     * Проверить, нужно ли логировать прогресс
     */
    shouldLogProgress() {
        const now = Date.now();
        const finished = this.successfulDownloads + this.failedDownloads;
        return finished === this.totalFiles ||
               now - this.lastProgressLogAt >= PROGRESS_LOG_INTERVAL_SECONDS * 1000;
    }

    /**
     * Записать время последнего логирования
     */
    markLogged() {
        this.lastProgressLogAt = Date.now();
    }

    /**
     * Сбросить состояние
     */
    reset() {
        this.downloadStartedAt = Date.now();
        this.lastProgressLogAt = 0;
        this.speedHistory = [];
        this.totalFiles = 0;
        this.successfulDownloads = 0;
        this.failedDownloads = 0;
        this.activeDownloads = 0;
    }

    /**
     * Логирование прогресса проверки файлов
     */
    static logCheckProgress(checked, total, skipped, newFiles, startedAt) {
        const { logMessage } = require('../utils/helper');
        
        const percent = total > 0 ? Math.round((checked * 100) / total) : 100;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const timestamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
        logMessage.info(
            `[${timestamp}] Check progress: ${checked}/${total} (${percent}%), skipped: ${skipped}, new: ${newFiles}, elapsed: ${elapsed}s`
        );
    }
}

module.exports = {
    ProgressLogger,
    formatEta,
    formatBytes,
    PROGRESS_LOG_INTERVAL_SECONDS
};
