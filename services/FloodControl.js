const { wait } = require("../utils/helper");
const { logMessage } = require("../utils/helper");
const config = require("../utils/config");
const { parseFloodWaitSeconds, getErrorText, isFileReferenceExpired: isFileRefExpired } = require("../utils/flood_utils");

const MAX_RPC_RETRIES = 5;

/**
 * Сервис для управления Flood Wait ограничениями Telegram API
 */
class FloodControl {
	constructor(options = {}) {
		this.cooldownUntil = 0;
		this.waitFn = options.waitFn || wait;
		this.nowFn = options.nowFn || Date.now;
		this.currentParallelLimit = config.get("download.maxParallel");
		this.consecutiveFloods = 0;
		this.successStreak = 0;

		// Слушатель для динамического обновления maxParallel
		this.configListener = (changedKeys) => {
			if (changedKeys.some((key) => key.startsWith("download.maxParallel") || key === "download")) {
				const newMaxParallel = config.get("download.maxParallel");
				if (this.currentParallelLimit > newMaxParallel) {
					this.currentParallelLimit = newMaxParallel;
					logMessage.flood(`[FLOOD] Config changed: maxParallel reduced to ${this.currentParallelLimit}`);
				}
			}
		};
		this.removeConfigListener = config.addListener(this.configListener);

		logMessage.flood(
			`[FLOOD] FloodControl created: maxParallel=${config.get("download.maxParallel")}, baseDelay=${config.get("download.baseRpcDelaySeconds")}s`,
		);
	}

	/**
	 * Парсить секунды ожидания из ошибки Flood Wait с логированием
	 */
	_parseFloodWaitSeconds(err) {
		const seconds = parseFloodWaitSeconds(err);
		logMessage.flood(seconds !== null ? `[FLOOD] Flood wait: ${seconds}s` : `[FLOOD] No flood wait: ${getErrorText(err)}`);
		return seconds;
	}

	/**
	 * Возможно подождать кулдаун перед следующим вызовом
	 * @returns {number} Количество секунд ожидания
	 */
	async maybeWaitCooldown() {
		const now = this.nowFn();
		if (this.cooldownUntil > now) {
			const remainingSeconds = Math.ceil((this.cooldownUntil - now) / 1000);
			logMessage.flood(
				`[FLOOD] Cooldown active: now=${now}, cooldownUntil=${this.cooldownUntil}, remaining=${remainingSeconds}s`,
			);
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
				logMessage.flood(
					`[FLOOD] Waiting ${waitSeconds}s before attempt ${attempt}/${MAX_RPC_RETRIES} for ${label}`,
				);
				await this.waitFn(waitSeconds);
			}

			const baseDelay = config.get("download.baseRpcDelaySeconds");
			if (baseDelay > 0) {
				logMessage.flood(`[FLOOD] Applying base delay: ${baseDelay}s`);
				await this.waitFn(baseDelay);
			}

			try {
				logMessage.flood(`[FLOOD] Executing ${label} (attempt ${attempt}/${MAX_RPC_RETRIES})`);
				const startTime = Date.now();
				const result = await fn();
				const elapsed = Date.now() - startTime;

				this.successStreak += 1;
				logMessage.flood(`[FLOOD] ${label} succeeded in ${elapsed}ms, successStreak=${this.successStreak}`);

				// Увеличиваем лимит параллельных загрузок при успешной серии
				const maxParallel = config.get("download.maxParallel");
				if (this.successStreak >= 30 && this.currentParallelLimit < maxParallel) {
					this.currentParallelLimit += 1;
					this.successStreak = 0;
					logMessage.flood(
						`[FLOOD] Increasing parallel limit to ${this.currentParallelLimit} (successStreak threshold reached)`,
					);
				}

				return result;
			} catch (err) {
				const floodSeconds = this._parseFloodWaitSeconds(err);

				logMessage.flood(
					`[FLOOD] ${label} failed: ${err?.message || err?.errorMessage || String(err)}, floodSeconds=${floodSeconds}`,
				);

				if (floodSeconds) {
					this.consecutiveFloods += 1;
					this.successStreak = 0;
					const oldLimit = this.currentParallelLimit;
					const minParallel = config.get("download.minParallel");
					this.currentParallelLimit = Math.max(minParallel, this.currentParallelLimit - 1);
					this.cooldownUntil = this.nowFn() + (floodSeconds + 1) * 1000;

					logMessage.error(
						`[FLOOD] FLOOD_WAIT detected in ${label}. Wait ${floodSeconds}s, retry ${attempt}/${MAX_RPC_RETRIES}. Parallel limit: ${oldLimit} -> ${this.currentParallelLimit}`,
					);
					logMessage.flood(
						`[FLOOD] State: consecutiveFloods=${this.consecutiveFloods}, successStreak=${this.successStreak}, cooldownUntil=${this.cooldownUntil}`,
					);

					// Не ждём здесь - maybeWaitCooldown в следующей итерации сам подождёт
					continue;
				}
				if (isFileRefExpired(err)) {
					logMessage.warn(`[FLOOD] FILE_REFERENCE_EXPIRED in ${label}: ${err?.message || err}`);
					err._isFileReferenceExpired = true;
				}
				throw err;
			}
		}

		const error = new Error(`Exceeded retry limit (${MAX_RPC_RETRIES}) for ${label} due to flood protection`);
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
		this.currentParallelLimit = config.get("download.maxParallel");
		this.consecutiveFloods = 0;
		this.successStreak = 0;
		logMessage.flood(`[FLOOD] State reset: parallelLimit=${oldLimit} -> ${this.currentParallelLimit}`);
	}

	/**
	 * Освободить ресурсы экземпляра
	 */
	cleanup() {
		if (typeof this.removeConfigListener === "function") {
			this.removeConfigListener();
			this.removeConfigListener = null;
		}
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
			now: this.nowFn(),
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
	isFileReferenceExpired: isFileRefExpired,
};
