const { TelegramClient } = require("telegram");
const { Logger } = require("telegram/extensions");
const { updateCredentials, getCredentials } = require("../utils/file_helper");

const { StringSession } = require("telegram/sessions");
const { logMessage } = require("../utils/helper");

const {
	textInput,
	mobileNumberInput,
	optInput,
	selectInput,
} = require("../utils/input_helper");

const OTP_METHOD = {
	SMS: "sms",
	APP: "app",
};
const MAX_AUTH_RETRIES = 3;

const getErrorText = (err) =>
	(err?.errorMessage || err?.message || String(err) || "").toUpperCase();

const parseFloodWaitSeconds = (err) => {
	const directSeconds = Number(err?.seconds);
	if (Number.isFinite(directSeconds) && directSeconds > 0) {
		return directSeconds;
	}
	const text = getErrorText(err);
	const floodMatch = text.match(/FLOOD_WAIT_?(\d+)/);
	if (floodMatch?.[1]) {
		return Number(floodMatch[1]);
	}
	const waitMatch = text.match(/A WAIT OF (\d+) SECONDS/);
	if (waitMatch?.[1]) {
		return Number(waitMatch[1]);
	}
	return null;
};

const initAuth = async (otpPreference = OTP_METHOD.APP) => {
	const credentials = getCredentials();
	const { apiId, apiHash, sessionId: savedSessionId } = credentials;

	logMessage.auth(`Auth init: apiId=${apiId ? "present" : "MISSING"}, sessionId=${savedSessionId ? "present" : "empty"}, otpPreference=${otpPreference}`);

	if (!apiId || !apiHash) {
		logMessage.error("[AUTH] Missing apiId or apiHash in credentials");
		throw new Error("Missing apiId or apiHash in config.json");
	}

	// Create StringSession from savedSessionId or use empty string for new session
	const stringSession = savedSessionId ? new StringSession(savedSessionId) : new StringSession("");
	logMessage.auth(`StringSession created: ${savedSessionId ? "resumed from saved session" : "new session"}`);

	const clientConfig = {
		connectionRetries: 5,
		baseLogger: new Logger("error"),
		deviceModel: "PC",
		systemVersion: "Windows 11",
		appVersion: "4.8.1",
		langCode: "en",
		systemLangCode: "en",
	};
	logMessage.auth(`Creating TelegramClient with config: deviceModel=${clientConfig.deviceModel}, appVersion=${clientConfig.appVersion}, connectionRetries=${clientConfig.connectionRetries}`);

	const client = new TelegramClient(stringSession, apiId, apiHash, clientConfig);
	logMessage.auth("TelegramClient instantiated");

	try {
		if (!savedSessionId) {
			logMessage.auth("No saved session - requesting OTP method from user");
			otpPreference = await selectInput("Where do you want the login OTP:", [OTP_METHOD.APP, OTP_METHOD.SMS]);
		} else {
			logMessage.auth("Saved session exists, attempting to resume without OTP");
		}

		const forceSMS = otpPreference == OTP_METHOD.SMS ? true : false;
		logMessage.auth(`Starting auth flow: forceSMS=${forceSMS}, maxRetries=${MAX_AUTH_RETRIES}`);

		for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
			try {
				logMessage.auth(`Auth attempt ${attempt}/${MAX_AUTH_RETRIES}`);
				await client.start({
					phoneNumber: async () => {
						logMessage.auth("Requesting phone number from user");
						const phoneNumber = await mobileNumberInput();
						// Telegram auth API expects international number; normalize to + prefix.
						const normalized = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;
						logMessage.auth(`Phone number received (normalized): ${normalized.substring(0, 5)}***`);
						return normalized;
					},
					password: async () => {
						logMessage.auth("Requesting 2FA password from user");
						return await textInput("Enter your password");
					},
					phoneCode: async () => {
						logMessage.info("Enter the code you received in Telegram app or by SMS");
						logMessage.auth("Requesting OTP code from user");
						return await optInput();
					},

					forceSMS,
					onError: (err) => {
						const errText = getErrorText(err);
						logMessage.auth(`Auth error callback triggered: ${errText}`);
						if (errText.includes("PHONE_NUMBER_INVALID")) {
							logMessage.error("Phone number is invalid. Use full international format, e.g. +14155552671.");
							return;
						}
						if (errText.includes("PHONE_CODE_INVALID")) {
							logMessage.error("OTP code is invalid. Please try again carefully.");
							return;
						}
						if (errText.includes("PHONE_CODE_EXPIRED")) {
							logMessage.error("OTP expired. Restart login to request a new code.");
							return;
						}
						if (errText.includes("FLOOD_WAIT")) {
							logMessage.error("Too many attempts. Telegram temporarily blocked new login attempts (FLOOD_WAIT).");
							return;
						}
						logMessage.error(`[AUTH] Unexpected auth error: ${errText}`);
					},
				});
				logMessage.auth(`Auth attempt ${attempt} succeeded`);
				break;
			} catch (err) {
				const floodSeconds = parseFloodWaitSeconds(err);
				logMessage.auth(`Auth attempt ${attempt} failed: ${err?.errorMessage || err?.message}, floodSeconds=${floodSeconds}`);
				if (floodSeconds && attempt < MAX_AUTH_RETRIES) {
					const waitSeconds = Math.ceil(floodSeconds) + 2;
					logMessage.warn(`[AUTH] Flood wait detected. Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_AUTH_RETRIES}.`);
					logMessage.debug(`[AUTH] Flood wait details: raw error=${err?.errorMessage || err?.message}, parsed seconds=${floodSeconds}, calculated wait=${waitSeconds}`);
					await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
					continue;
				}
				logMessage.error(`[AUTH] Auth failed after ${attempt} attempts: ${err?.message || err}`);
				throw err;
			}
		}

		logMessage.success("[AUTH] You should now be connected.");
		if (!savedSessionId) {
			const newSessionId = client.session.save();
			logMessage.auth(`Session saved (first login): ${newSessionId.substring(0, 20)}...`);
			updateCredentials({ sessionId: newSessionId });
			logMessage.info(`[AUTH] Session id has been saved to config.json`);
		} else {
			logMessage.auth("Session resumed successfully from saved sessionId");
		}

		return client;
	} catch (err) {
		logMessage.error(`[AUTH] Fatal auth error: ${err?.message || err}`);
		// Пробрасываем ошибку, чтобы клиент не использовался в некорректном состоянии
		throw err;
	}
};

module.exports = {
	initAuth,
};
