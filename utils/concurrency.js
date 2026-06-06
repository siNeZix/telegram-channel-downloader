const os = require("os");

const DEFAULT_CONCURRENCY = 10;

/**
 * Resolve a sane default concurrency based on available CPU cores, capped to a
 * ceiling so we never spawn an unbounded number of CPU-bound ffmpeg processes.
 * @param {number} [cap=8]
 * @returns {number}
 */
function defaultConcurrency(cap = 8) {
	let cpus = 1;
	try {
		cpus = os.cpus()?.length || 1;
	} catch {
		cpus = 1;
	}
	return Math.max(1, Math.min(cap, cpus));
}

/**
 * Run an async worker over a list of items using a fixed-size pool of workers
 * that share a single incrementing index (no chunking). Results are returned in
 * the original item order. Worker rejections are captured per-item instead of
 * aborting the whole pool.
 *
 * @template TItem, TResult
 * @param {TItem[]} items
 * @param {(item: TItem, index: number) => Promise<TResult>} worker
 * @param {Object} [options]
 * @param {number} [options.concurrency] - Max parallel workers (default 10).
 * @returns {Promise<Array<{ ok: boolean, value?: TResult, error?: Error, item: TItem, index: number }>>}
 */
async function runPool(items, worker, options = {}) {
	const list = Array.isArray(items) ? items : [];
	if (list.length === 0) {
		return [];
	}

	const requested = Number(options.concurrency);
	const concurrency = Math.max(
		1,
		Math.min(
			list.length,
			Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_CONCURRENCY,
		),
	);

	const results = new Array(list.length);
	let activeIndex = 0;

	const runWorker = async () => {
		while (activeIndex < list.length) {
			const currentIndex = activeIndex++;
			const item = list[currentIndex];
			try {
				const value = await worker(item, currentIndex);
				results[currentIndex] = { ok: true, value, item, index: currentIndex };
			} catch (error) {
				results[currentIndex] = {
					ok: false,
					error: error instanceof Error ? error : new Error(String(error)),
					item,
					index: currentIndex,
				};
			}
		}
	};

	const workers = [];
	for (let i = 0; i < concurrency; i++) {
		workers.push(runWorker());
	}
	await Promise.all(workers);

	return results;
}

module.exports = {
	runPool,
	defaultConcurrency,
	DEFAULT_CONCURRENCY,
};
