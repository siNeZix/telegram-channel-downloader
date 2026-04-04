const path = require('path');

/**
 * Централизованный менеджер путей проекта
 * Использует абсолютные пути на основе __dirname для надежности
 */
class PathsManager {
    constructor() {
        // Корень проекта (на один уровень выше utils)
        this.root = path.resolve(__dirname, '..');
        this.export = path.join(this.root, 'export');
        this.config = path.join(this.root, 'config.json');
        this.lastSelection = path.join(this.export, 'last_selection.json');
        this.snapshots = 'snapshots';
    }

    /**
     * Получить путь к папке экспорта для конкретного канала
     * @param {string|number} channelId - ID канала
     * @returns {string}
     */
    getChannelExportPath(channelId) {
        return path.join(this.export, String(channelId));
    }

    /**
     * Получить путь к папке медиа для конкретного канала
     * @param {string|number} channelId - ID канала
     * @param {string} mediaType - Тип медиа (image, video, audio и т.д.)
     * @returns {string}
     */
    getMediaPath(channelId, mediaType) {
        return path.join(this.getChannelExportPath(channelId), mediaType);
    }

    /**
     * Получить путь к файлу базы данных канала
     * @param {string|number} channelId - ID канала
     * @returns {string}
     */
    getChannelDbPath(channelId) {
        return path.join(this.getChannelExportPath(channelId), 'messages.db');
    }

    /**
     * Получить путь к папке снапшотов канала
     * @param {string|number} channelId - ID канала
     * @returns {string}
     */
    getSnapshotsPath(channelId) {
        return path.join(this.getChannelExportPath(channelId), this.snapshots);
    }

    /**
     * Получить путь к сырым сообщениям канала
     * @param {string|number} channelId - ID канала
     * @returns {string}
     */
    getRawMessagesPath(channelId) {
        return path.join(this.getChannelExportPath(channelId), 'raw_message.json');
    }

    /**
     * Получить путь к обработанным сообщениям канала
     * @param {string|number} channelId - ID канала
     * @returns {string}
     */
    getProcessedMessagesPath(channelId) {
        return path.join(this.getChannelExportPath(channelId), 'all_message.json');
    }

    /**
     * Получить путь к списку диалогов
     * @returns {string}
     */
    getDialogListPath() {
        return path.join(this.export, 'dialog_list.json');
    }

    /**
     * Проверить существование пути и создать директорию если нужно
     * @param {string} dirPath - Путь к директории
     */
    ensureDir(dirPath) {
        const fs = require('fs');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
}

// Создаем синглтон для использования во всем приложении
const pathsManager = new PathsManager();

module.exports = pathsManager;
