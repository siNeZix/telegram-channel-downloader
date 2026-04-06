const fs = require('fs');
const path = require('path');
const pathsManager = require('./paths');

/** @type {fs.WriteStream|null} */
let debugStream = null;
/** @type {fs.WriteStream|null} */
let normalStream = null;

/** Регулярка для удаления ANSI-цветов */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
/** Максимальное количество архивных логов */
const MAX_ARCHIVE_FILES = 50;
/** Имя файла с полным дебаг-логом */
const DEBUG_LOG_NAME = 'debug.log';
/** Имя текущего обычного лога */
const CURRENT_LOG_NAME = 'current.log';
/** Регулярка для определения архивных логов по дате */
const ARCHIVE_LOG_REGEX = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/;

/** Timestamp последнего лога (для расчёта дельты) */
let lastLogTimestamp = null;

/**
 * Удалить ANSI escape-последовательности из строки
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
    return str.replace(ANSI_REGEX, '');
}

/**
 * Форматировать дату для имени файла
 * @param {Date} date
 * @returns {string}
 */
function formatDateForFilename(date) {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d}-${h}-${mi}-${s}`;
}

/**
 * Очистить папку логов от старых архивов, оставив не более MAX_ARCHIVE_FILES
 */
function cleanupOldArchives() {
    const logsDir = pathsManager.logs;

    if (!fs.existsSync(logsDir)) return;

    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => ARCHIVE_LOG_REGEX.test(f))
            .map(f => {
                const filePath = path.join(logsDir, f);
                const stats = fs.statSync(filePath);
                return { name: f, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length > MAX_ARCHIVE_FILES) {
            const toDelete = files.slice(MAX_ARCHIVE_FILES);
            for (const file of toDelete) {
                const filePath = path.join(logsDir, file.name);
                fs.unlinkSync(filePath);
            }
        }
    } catch (err) {
        // Игнорируем ошибки чтения/удаления при очистке
    }
}

/**
 * Инициализировать логгер: создать папку, архивировать старые логи, открыть потоки
 */
function init() {
    const logsDir = pathsManager.logs;

    // 1. Создать папку логов
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    // 2. Архивировать предыдущий обычный лог (current.log -> yyyy-mm-dd-hh-mm-ss.log)
    const currentLogPath = path.join(logsDir, CURRENT_LOG_NAME);
    if (fs.existsSync(currentLogPath)) {
        const archiveName = formatDateForFilename(new Date()) + '.log';
        const archivePath = path.join(logsDir, archiveName);
        try {
            fs.renameSync(currentLogPath, archivePath);
        } catch (err) {
            // Если не удалось переименовать (файл занят), просто удалим
            try { fs.unlinkSync(currentLogPath); } catch (e) {}
        }
    }

    // 3. Очистить debug.log (перезаписать)
    const debugLogPath = path.join(logsDir, DEBUG_LOG_NAME);
    fs.writeFileSync(debugLogPath, '');

    // 4. Очистить старые архивы
    cleanupOldArchives();

    // 5. Открыть потоки записи
    debugStream = fs.createWriteStream(debugLogPath, { flags: 'a', encoding: 'utf8' });
    normalStream = fs.createWriteStream(currentLogPath, { flags: 'a', encoding: 'utf8' });
}

/**
 * Записать сообщение в лог с расчётом дельты времени
 * @param {string} level - Уровень лога (debug, info, success, warn, error)
 * @param {string} message - Сообщение (может содержать ANSI коды)
 */
function write(level, message) {
    if (!debugStream || !normalStream) {
        init();
    }

    const cleanMessage = stripAnsi(message);
    const now = new Date();
    const timestamp = now.toISOString();
    
    // Рассчитываем дельту времени с момента последнего лога
    let deltaStr = '';
    if (lastLogTimestamp !== null) {
        const deltaMs = now - lastLogTimestamp;
        // Форматируем дельту для наглядности: ms или s.ms
        if (deltaMs >= 1000) {
            deltaStr = ` (+${(deltaMs / 1000).toFixed(2)}s)`;
        } else {
            deltaStr = ` (+${deltaMs}ms)`;
        }
    }
    lastLogTimestamp = now;
    
    const fileLine = `[${timestamp}] [${level.toUpperCase()}]${deltaStr} ${cleanMessage}\n`;

    // Все пишем в debug.log
    debugStream.write(fileLine);

    // Важные уровни пишем в current.log
    const normalLevels = ['info', 'success', 'warn', 'error'];
    if (normalLevels.includes(level)) {
        normalStream.write(fileLine);
    }
}

/**
 * Закрыть потоки логирования (вызывать при завершении приложения)
 */
function close() {
    if (debugStream) {
        debugStream.end();
        debugStream = null;
    }
    if (normalStream) {
        normalStream.end();
        normalStream = null;
    }
}

module.exports = {
    init,
    write,
    close,
    stripAnsi,
};
