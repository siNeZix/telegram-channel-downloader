const MAX_CACHE_SIZE = 1000;

class TelegramEntityResolver {
	constructor(client) {
		this.client = client;
		// Map preserves insertion order, so it doubles as an O(1) LRU list:
		// the first key is the oldest, re-inserting a key marks it most-recent.
		this.entityCache = new Map();
	}

	_touch(cacheKey, entity) {
		// Move/insert the key to the most-recent position.
		this.entityCache.delete(cacheKey);
		this.entityCache.set(cacheKey, entity);
	}

	_ejectOldest() {
		while (this.entityCache.size > MAX_CACHE_SIZE) {
			const oldest = this.entityCache.keys().next().value;
			this.entityCache.delete(oldest);
		}
	}

	async resolve(peerRef) {
		const cacheKey = String(peerRef);
		if (this.entityCache.has(cacheKey)) {
			const entity = this.entityCache.get(cacheKey);
			this._touch(cacheKey, entity);
			return entity;
		}

		let entity;
		try {
			entity = await this.client.getInputEntity(peerRef);
		} catch (error) {
			// Populate Telegram's internal entity cache before retrying raw numeric IDs.
			await this.client.getDialogs();
			entity = await this.client.getInputEntity(peerRef);
		}

		this.entityCache.set(cacheKey, entity);
		this._ejectOldest();
		return entity;
	}
}

module.exports = {
	TelegramEntityResolver,
};
