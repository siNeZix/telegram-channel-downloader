const { wait } = require('../utils/helper');
const { logMessage } = require('../utils/helper');

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
        logMessage.flood(`[FLOOD] FloodControl created: maxParallel=${MAX_PARALLEL_DOWNLOAD}, baseDelay=${BASE_RPC_DELAY_SECONDS}s`);
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
            logMessage.flood(`[FLOOD] Parsed flood wait from .seconds: ${directSeconds}s`);
            return directSeconds;
        }
        const text = this.getErrorText(err);
        const floodMatch = text.match(/FLOOD_WAIT_?(\d+)/);
        if (floodMatch?.[1]) {
            const parsed = Number(floodMatch[1]);
            logMessage.flood(`[FLOOD] Parsed flood wait from text: ${parsed}s`);
            return parsed;
        }
        const waitMatch = text.match(/A WAIT OF (\d+) SECONDS/);
        if (waitMatch?.[1]) {
            const parsed = Number(waitMatch[1]);
            logMessage.flood(`[FLOOD] Parsed flood wait from 'A WAIT OF' match: ${parsed}s`);
            return parsed;
        }
        logMessage.flood(`[FLOOD] No flood wait detected in error: ${text}`);
        return null;
    }

    /**
     * Возможно подождать кулдаун перед следующим вызовом
     * @returns {number} Количество секунд ожидания
     */
    async maybeWaitCooldown() {
        const now = Date.now();
        if (this.cooldownUntil > now) {
            const remainingSeconds = Math.ceil((this.cooldownUntil - now) / 1000);
            logMessage.flood(`[FLOOD] Cooldown active: now=${now}, cooldownUntil=${this.cooldownUntil}, remaining=${remainingSeconds}s`);
            return remainingSeconds;
        }
        logMessage.flood(`[FLOOD] No cooldown needed: now=${now}, cooldownUntil=${this.cooldownUntil}`);
        return 0;
    }

    /**
     * Выполнить функцию с контролем Flood Wait
     * @param {string} label - Метка для логирования
     * @param {Function} fn - Асинхронная функция для выполнения
     * @returns {Promise<any>}
     */
    async runWithFloodControl(label, fn) {
        logMessage.flood(`[FLOOD] runWithFloodControl: label=${label}, maxRetries=${MAX_RPC_RETRIES}`);
        
        for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
            const waitSeconds = await this.maybeWaitCooldown();
            if (waitSeconds > 0) {
                logMessage.flood(`[FLOOD] Waiting ${waitSeconds}s before attempt ${attempt}/${MAX_RPC_RETRIES} for ${label}`);
                await wait(waitSeconds);
            }
            
            if (BASE_RPC_DELAY_SECONDS > 0) {
                logMessage.flood(`[FLOOD] Applying base delay: ${BASE_RPC_DELAY_SECONDS}s`);
                await wait(BASE_RPC_DELAY_SECONDS);
            }
            
            try {
                logMessage.flood(`[FLOOD] Executing ${label} (attempt ${attempt}/${MAX_RPC_RETRIES})`);
                const startTime = Date.now();
                const result = await fn();
                const elapsed = Date.now() - startTime;
                
                this.successStreak += 1;
                logMessage.flood(`[FLOOD] ${label} succeeded in ${elapsed}ms, successStreak=${this.successStreak}`);
                
                // Увеличиваем лимит параллельных загрузок при успешной серии
                if (this.successStreak >= 30 && this.currentParallelLimit < MAX_PARALLEL_DOWNLOAD) {
                    this.currentParallelLimit += 1;
                    this.successStreak = 0;
                    logMessage.flood(`[FLOOD] Increasing parallel limit to ${this.currentParallelLimit} (successStreak threshold reached)`);
                }
                
                return result;
            } catch (err) {
                const floodSeconds = this.parseFloodWaitSeconds(err);
                
                logMessage.flood(`[FLOOD] ${label} failed: ${err?.message || err?.errorMessage || String(err)}, floodSeconds=${floodSeconds}`);
                
                if (floodSeconds) {
                    this.consecutiveFloods += 1;
                    this.successStreak = 0;
                    const oldLimit = this.currentParallelLimit;
                    this.currentParallelLimit = Math.max(
                        MIN_PARALLEL_DOWNLOAD,
                        this.currentParallelLimit - 1
                    );
                    this.cooldownUntil = Date.now() + (floodSeconds + 1) * 1000;
                    
                    logMessage.error(
                        `[FLOOD] FLOOD_WAIT detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit: ${oldLimit} -> ${this.currentParallelLimit}`
                    );
                    logMessage.flood(`[FLOOD] State: consecutiveFloods=${this.consecutiveFloods}, successStreak=${this.successStreak}, cooldownUntil=${this.cooldownUntil}`);
                    
                    // Не ждём здесь - maybeWaitCooldown в следующей итерации сам подождёт
                    continue;
                }
                logMessage.error(`[FLOOD] Non-flood error in ${label}: ${err?.message || err}`);
                throw err;
            }
        }
        
        const error = new Error(
            `Exceeded retry limit (${MAX_RPC_RETRIES}) for ${label} due to flood protection`
        );
        logMessage.error(`[FLOOD] ${error.message}`);
        throw error;
    }

    /**
     * Получить текущий лимит параллельных загрузок
     * @returns {number}
     */
    getParallelLimit() {
        logMessage.flood(`[FLOOD] getParallelLimit: ${this.currentParallelLimit}`);
        return this.currentParallelLimit;
    }

    /**
     * Сбросить состояние
     */
    reset() {
        const oldLimit = this.currentParallelLimit;
        this.cooldownUntil = 0;
        this.currentParallelLimit = MAX_PARALLEL_DOWNLOAD;
        this.consecutiveFloods = 0;
        this.successStreak = 0;
        logMessage.flood(`[FLOOD] State reset: parallelLimit=${oldLimit} -> ${this.currentParallelLimit}`);
    }
    
    /**
     * Получить статистику состояния
     * @returns {Object}
     */
    getStats() {
        return {
            parallelLimit: this.currentParallelLimit,
            cooldownUntil: this.cooldownUntil,
            consecutiveFloods: this.consecutiveFloods,
            successStreak: this.successStreak,
            now: Date.now()
        };
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
