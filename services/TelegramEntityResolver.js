class TelegramEntityResolver {
	constructor(client) {
		this.client = client;
		this.entityCache = new Map();
	}

	async resolve(peerRef) {
		const cacheKey = String(peerRef);
		if (this.entityCache.has(cacheKey)) {
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
		return entity;
	}
}

module.exports = {
	TelegramEntityResolver,
};
