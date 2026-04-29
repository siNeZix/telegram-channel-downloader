const MAX_CACHE_SIZE = 1000;

class TelegramEntityResolver {
	constructor(client) {
		this.client = client;
		this.entityCache = new Map();
		this.accessOrder = [];
	}

	_ejectOldest() {
		while (this.accessOrder.length > MAX_CACHE_SIZE) {
			const oldest = this.accessOrder.shift();
			this.entityCache.delete(oldest);
		}
	}

	async resolve(peerRef) {
		const cacheKey = String(peerRef);
		if (this.entityCache.has(cacheKey)) {
			const idx = this.accessOrder.indexOf(cacheKey);
			if (idx !== -1) {
				this.accessOrder.splice(idx, 1);
				this.accessOrder.push(cacheKey);
			}
			return this.entityCache.get(cacheKey);
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
		this.accessOrder.push(cacheKey);
		this._ejectOldest();
		return entity;
	}
}

module.exports = {
	TelegramEntityResolver,
};
