const { wait } = require('../utils/helper');

const BASE_RPC_DELAY_SECONDS = 0.05;
const MAX_RPC_RETRIES = 5;
const MIN_PARALLEL_DOWNLOAD = 2;
const MAX_PARALLEL_DOWNLOAD = 20;

/**
 * Сервис для управления Flood Wait ограничениями Telegram API
 */
class FloodControl {
    constructor() {
        this.cooldownUntil = 0;
        this.currentParallelLimit = MAX_PARALLEL_DOWNLOAD;
        this.consecutiveFloods = 0;
        this.successStreak = 0;
    }

    /**
     * Получить текст ошибки
     * @param {Error} err 
     * @returns {string}
     */
    getErrorText(err) {
        return (err?.errorMessage || err?.message || String(err) || "").toUpperCase();
    }

    /**
     * Парсить секунды ожидания из ошибки Flood Wait
     * @param {Error} err 
     * @returns {number|null}
     */
    parseFloodWaitSeconds(err) {
        const directSeconds = Number(err?.seconds);
        if (Number.isFinite(directSeconds) && directSeconds > 0) {
            return directSeconds;
        }
        const text = this.getErrorText(err);
        const floodMatch = text.match(/FLOOD_WAIT_?(\d+)/);
        if (floodMatch?.[1]) {
            return Number(floodMatch[1]);
        }
        const waitMatch = text.match(/A WAIT OF (\d+) SECONDS/);
        if (waitMatch?.[1]) {
            return Number(waitMatch[1]);
        }
        return null;
    }

    /**
     * Возможно подождать кулдаун перед следующим вызовом
     */
    async maybeWaitCooldown() {
        const now = Date.now();
        if (this.cooldownUntil > now) {
            const remainingSeconds = Math.ceil((this.cooldownUntil - now) / 1000);
            return remainingSeconds;
        }
        return 0;
    }

    /**
     * Выполнить функцию с контролем Flood Wait
     * @param {string} label - Метка для логирования
     * @param {Function} fn - Асинхронная функция для выполнения
     * @returns {Promise<any>}
     */
    async runWithFloodControl(label, fn) {
        for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
            const waitSeconds = await this.maybeWaitCooldown();
            if (waitSeconds > 0) {
                const { logMessage } = require('../utils/helper');
                logMessage.info(`Flood cooldown active, waiting ${waitSeconds}s before next API call`);
                await wait(waitSeconds);
            }
            
            if (BASE_RPC_DELAY_SECONDS > 0) {
                await wait(BASE_RPC_DELAY_SECONDS);
            }
            
            try {
                const result = await fn();
                this.successStreak += 1;
                
                // Увеличиваем лимит параллельных загрузок при успешной серии
                if (this.successStreak >= 30 && this.currentParallelLimit < MAX_PARALLEL_DOWNLOAD) {
                    this.currentParallelLimit += 1;
                    this.successStreak = 0;
                    const { logMessage } = require('../utils/helper');
                    logMessage.info(`Flood control: increased parallel limit to ${this.currentParallelLimit}`);
                }
                
                return result;
            } catch (err) {
                const floodSeconds = this.parseFloodWaitSeconds(err);
                
                if (floodSeconds) {
                    this.consecutiveFloods += 1;
                    this.successStreak = 0;
                    this.currentParallelLimit = Math.max(
                        MIN_PARALLEL_DOWNLOAD,
                        this.currentParallelLimit - 1
                    );
                    this.cooldownUntil = Date.now() + (floodSeconds + 1) * 1000;
                    
                    const { logMessage } = require('../utils/helper');
                    logMessage.error(
                        `Flood detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit now ${this.currentParallelLimit}`
                    );
                    
                    // Не ждём здесь - maybeWaitCooldown в следующей итерации сам подождёт
                    continue;
                }
                throw err;
            }
        }
        
        throw new Error(
            `Exceeded retry limit (${MAX_RPC_RETRIES}) for ${label} due to flood protection`
        );
    }

    /**
     * Получить текущий лимит параллельных загрузок
     * @returns {number}
     */
    getParallelLimit() {
        return this.currentParallelLimit;
    }

    /**
     * Сбросить состояние
     */
    reset() {
        this.cooldownUntil = 0;
        this.currentParallelLimit = MAX_PARALLEL_DOWNLOAD;
        this.consecutiveFloods = 0;
        this.successStreak = 0;
    }
}

/**
 * Фабрика для создания нового экземпляра FloodControl
 */
const createFloodState = () => {
    const control = new FloodControl();
    return control;
};

module.exports = {
    FloodControl,
    createFloodState,
    MAX_PARALLEL_DOWNLOAD,
    MIN_PARALLEL_DOWNLOAD
};
