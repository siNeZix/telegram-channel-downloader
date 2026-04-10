const fs = require('fs');
const path = require('path');
const pathsManager = require('./paths');

/**
 * Значения конфигурации по умолчанию
 */
const DEFAULTS = {
    apiId: null,
    apiHash: null,
    sessionId: null,
    download: {
        maxParallel: 20,
        minParallel: 2,
        baseRpcDelaySeconds: 0.05,
        messageLimit: 200,
        fastForwardMessageLimit: 1000,
        checkProgressIntervalFiles: 100,
    },
    logging: {
        progressLogIntervalSeconds: 5,
    },
};

/**
 * Класс для управления конфигурацией с поддержкой динамических изменений
 */
class ConfigManager {
    constructor() {
        this.config = this._deepClone(DEFAULTS);
        this.watchTimeout = null;
        this.suppressWatchUntil = 0;
        this.listeners = [];
        this._load();
        this._watch();
    }

    get configPath() {
        return pathsManager.config;
    }

    /**
     * Глубокое клонирование объекта
     * @param {Object} obj 
     * @returns {Object}
     */
    _deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * Глубокое слияние двух объектов (source перезаписывает target)
     * @param {Object} target 
     * @param {Object} source 
     * @returns {Object}
     */
    _deepMerge(target, source) {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (
                source[key] !== null &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                typeof target[key] === 'object' &&
                target[key] !== null &&
                !Array.isArray(target[key])
            ) {
                result[key] = this._deepMerge(target[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }

    /**
     * Загрузить конфигурацию из файла и слить с дефолтами
     */
    _load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const fileContent = fs.readFileSync(this.configPath, 'utf8');
                const trimmedContent = fileContent.trim();
                const fileConfig = trimmedContent === '' ? {} : JSON.parse(trimmedContent);
                const mergedConfig = this._deepMerge(this._deepClone(DEFAULTS), fileConfig);
                this.config = mergedConfig;
                
                // Проверяем, нужно ли сохранить новые поля
                const hasNewFields = JSON.stringify(mergedConfig) !== JSON.stringify(fileConfig);
                
                if (hasNewFields) {
                    this._save();
                }
            } else {
                // Файла нет - используем только дефолты и создаем файл
                this.config = this._deepClone(DEFAULTS);
                this._save();
            }
        } catch (error) {
            console.error('[CONFIG] Error loading config:', error.message);
            this.config = this._deepClone(DEFAULTS);
        }
    }

    /**
     * Сохранить текущую конфигурацию в файл
     */
    _save() {
        try {
            // Создаем директорию если её нет
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.suppressWatchUntil = Date.now() + 1000;
            const tempPath = `${this.configPath}.tmp`;
            fs.writeFileSync(
                tempPath,
                JSON.stringify(this.config, null, 4),
                'utf8'
            );
            fs.renameSync(tempPath, this.configPath);
        } catch (error) {
            console.error('[CONFIG] Error saving config:', error.message);
        }
    }

    /**
     * Начать отслеживание изменений файла конфигурации
     */
    _watch() {
        try {
            fs.watch(this.configPath, (eventType) => {
                if (Date.now() < this.suppressWatchUntil) {
                    return;
                }

                if (eventType === 'change' || eventType === 'rename') {
                    // Debounce для избежания множественных срабатываний
                    if (this.watchTimeout) {
                        clearTimeout(this.watchTimeout);
                    }
                    this.watchTimeout = setTimeout(() => {
                        this._reload();
                    }, 100);
                }
            });
        } catch (error) {
            console.error('[CONFIG] Error setting up watcher:', error.message);
        }
    }

    /**
     * Перезагрузить конфигурацию и уведомить подписчиков
     */
    _reload() {
        const oldConfig = this._deepClone(this.config);
        this._load();
        
        // Проверяем, изменились ли критичные параметры
        const changedKeys = this._findChangedKeys(oldConfig, this.config, []);
        
        if (changedKeys.length > 0) {
            console.log(`[CONFIG] Reloaded. Changed: ${changedKeys.join(', ')}`);
            this._notifyListeners(changedKeys);
        }
    }

    /**
     * Найти ключи, которые изменились между двумя конфигами
     * @param {Object} oldObj 
     * @param {Object} newObj 
     * @param {Array} prefix 
     * @returns {Array}
     */
    _findChangedKeys(oldObj, newObj, prefix) {
        const changed = [];
        const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
        
        for (const key of allKeys) {
            const fullKey = prefix.length > 0 ? `${prefix.join('.')}.${key}` : key;
            
            if (
                typeof oldObj[key] === 'object' &&
                typeof newObj[key] === 'object' &&
                oldObj[key] !== null &&
                newObj[key] !== null &&
                !Array.isArray(oldObj[key]) &&
                !Array.isArray(newObj[key])
            ) {
                // Рекурсивно проверяем вложенные объекты
                changed.push(...this._findChangedKeys(oldObj[key], newObj[key], [...prefix, key]));
            } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
                changed.push(fullKey);
            }
        }
        
        return changed;
    }

    /**
     * Добавить слушателя изменений конфигурации
     * @param {Function} callback - Функция обратного вызова с массивом измененных ключей
     * @returns {Function} Функция для удаления слушателя
     */
    addListener(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }

    /**
     * Уведомить всех слушателей об изменении
     * @param {Array} changedKeys 
     */
    _notifyListeners(changedKeys) {
        for (const listener of this.listeners) {
            try {
                listener(changedKeys);
            } catch (error) {
                console.error('[CONFIG] Listener error:', error.message);
            }
        }
    }

    /**
     * Получить значение конфигурации
     * @param {string} key - Ключ в формате 'section.nested.value' или просто 'key'
     * @param {*} defaultValue - Значение по умолчанию, если ключ не найден
     * @returns {*}
     */
    get(key, defaultValue = undefined) {
        const keys = key.split('.');
        let value = this.config;
        
        for (const k of keys) {
            if (value === null || value === undefined || typeof value !== 'object') {
                return defaultValue !== undefined ? defaultValue : DEFAULTS;
            }
            value = value[k];
        }
        
        return value !== undefined ? value : (defaultValue !== undefined ? defaultValue : null);
    }

    /**
     * Установить значение конфигурации
     * @param {string} key - Ключ в формате 'section.nested.value'
     * @param {*} value - Новое значение
     * @param {boolean} save - Сохранить в файл сразу
     */
    set(key, value, save = true) {
        const keys = key.split('.');
        let obj = this.config;
        
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (typeof obj[k] !== 'object' || obj[k] === null) {
                obj[k] = {};
            }
            obj = obj[k];
        }
        
        obj[keys[keys.length - 1]] = value;
        
        if (save) {
            this._save();
        }
    }

    /**
     * Получить весь объект конфигурации
     * @returns {Object}
     */
    getAll() {
        return this._deepClone(this.config);
    }

    /**
     * Получить все значения секции
     * @param {string} section - Название секции
     * @returns {Object}
     */
    getSection(section) {
        return this._deepClone(this.config[section] || {});
    }
}

// Создаем синглтон
const configManager = new ConfigManager();

module.exports = configManager;
