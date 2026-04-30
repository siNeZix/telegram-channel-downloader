const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { MessageService, processMessageMedia, shouldDownload } = require("../services/MessageService");

const createService = () => new MessageService({});

test("MessageService.processMessage returns base fields for text-only messages", () => {
	const service = createService();

	try {
		const message = {
			id: 101,
			message: "hello",
			date: new Date("2024-01-01T00:00:00Z"),
			out: false,
			fromId: { userId: 55 },
		};

		const processed = service.processMessage(message, path.join("export", "1"), 1);

		assert.deepEqual(processed, {
			id: 101,
			message: "hello",
			date: new Date("2024-01-01T00:00:00Z"),
			out: false,
			sender: 55,
		});
	} finally {
		service.cleanup();
	}
});

test("MessageService.processMessage maps media metadata for document messages", () => {
	const service = createService();

	try {
		const outputFolder = path.join("export", "123");
		const message = {
			id: 202,
			message: "attachment",
			date: new Date("2024-02-01T00:00:00Z"),
			out: true,
			peerId: { userId: 77 },
			media: {
				document: {
					mimeType: "application/pdf",
					attributes: [
						{
							className: "DocumentAttributeFilename",
							fileName: "guide.pdf",
						},
					],
				},
			},
		};

		const processed = service.processMessage(message, outputFolder, 123);

		assert.equal(processed.id, 202);
		assert.equal(processed.sender, 77);
		assert.equal(processed.mediaType, "document");
		assert.equal(processed.mediaName, "file_202_guide.pdf");
		assert.equal(processed.mediaPath, path.join("document", "file_202_guide.pdf"));
		assert.equal(processed.isMedia, true);
	} finally {
		service.cleanup();
	}
});

test("MessageService.processMessage prefers fromId over peerId for sender and preserves media path shape", () => {
	const service = createService();

	try {
		const outputFolder = path.join("export", "555");
		const message = {
			id: 205,
			message: "photo",
			date: new Date("2024-03-01T00:00:00Z"),
			out: false,
			fromId: { userId: 88 },
			peerId: { userId: 99 },
			media: {
				photo: {},
			},
		};

		const processed = service.processMessage(message, outputFolder, 555);

		assert.equal(processed.sender, 88);
		assert.equal(processed.mediaType, "image");
		assert.equal(processed.mediaName, "file_205.jpg");
		assert.equal(processed.mediaPath, path.join("image", "file_205.jpg"));
		assert.equal(processed.isMedia, true);
	} finally {
		service.cleanup();
	}
});

test("processMessageMedia returns normalized media metadata", () => {
	const outputFolder = path.join("export", "321");
	const message = {
		id: 303,
		media: {
			photo: {},
		},
	};

	const info = processMessageMedia(message, outputFolder);

	assert.equal(info.mediaType, "image");
	assert.equal(info.mediaExtension, "jpg");
	assert.equal(info.fileName, "file_303.jpg");
	assert.equal(info.mediaPath, path.join(outputFolder, "image", "file_303.jpg"));
});

test("processMessageMedia returns null when message has no media", () => {
	assert.equal(processMessageMedia({ id: 404 }, "export"), null);
});

test("shouldDownload matches by media type, extension, or all flag", () => {
	assert.equal(shouldDownload("video", "mp4", { video: true }), true);
	assert.equal(shouldDownload("document", "pdf", { pdf: true }), true);
	assert.equal(shouldDownload("audio", "mp3", { all: true }), true);
	assert.equal(shouldDownload("audio", "mp3", { image: true }), undefined);
});

test("MessageService.getMessagesByIds resolves entity and forwards ids to client", async () => {
	const calls = [];
	const fakeClient = {
		getMessages: async (peer, options) => {
			calls.push({ peer, options });
			return [{ id: 1 }, { id: 2 }];
		},
	};

	const service = new MessageService(fakeClient);
	service.entityResolver = {
		resolve: async (channelId) => `peer:${channelId}`,
	};
	service.floodState = {
		runWithFloodControl: async (_label, fn) => fn(),
		cleanup: () => {},
	};

	try {
		const result = await service.getMessagesByIds(777, [11, 12], {
			outputFolder: path.join("export", "777"),
		});

		assert.deepEqual(result, [{ id: 1 }, { id: 2 }]);
		assert.deepEqual(calls, [
			{
				peer: "peer:777",
				options: { ids: [11, 12] },
			},
		]);
	} finally {
		service.cleanup();
	}
});
