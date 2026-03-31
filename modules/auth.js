const inquirer = require("inquirer");

const { TelegramClient } = require("telegram");
const { updateCredentials, getCredentials } = require("../utils/file_helper");

const { StringSession } = require("telegram/sessions");
const { logMessage } = require("../utils/helper");
const {
	textInput,
	mobileNumberInput,
	optInput,
	selectInput,
} = require("../utils/input_helper");

let { apiHash, apiId, sessionId } = getCredentials();
const stringSession = new StringSession(sessionId || "");
const OTP_METHOD = {
	SMS: "sms",
	APP: "app",
};

const initAuth = async (otpPreference = OTP_METHOD.APP) => {
	const client = new TelegramClient(stringSession, apiId, apiHash, {
		connectionRetries: 5,
		deviceModel: "PC", // Маскируемся под ПК
		systemVersion: "Windows 11", // Указываем правдоподобную ОС
		appVersion: "4.8.1", // Версия официального Telegram Desktop
		langCode: "en",
		systemLangCode: "en",
	});
	try {
		if (!sessionId) {
			otpPreference = await selectInput(
				"Where do you want the login OTP:",
				[OTP_METHOD.APP, OTP_METHOD.SMS],
			);
		}

		const forceSMS = otpPreference == OTP_METHOD.SMS ? true : false;
		await client.start({
			phoneNumber: async () => {
				const phoneNumber = await mobileNumberInput();
				// Telegram auth API expects international number; normalize to + prefix.
				return phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;
			},
			password: async () => await textInput("Enter your password"),
			phoneCode: async () => {
				logMessage.info(
					"Enter the code you received in Telegram app or by SMS",
				);
				return await optInput();
			},

			forceSMS,
			onError: (err) => {
				const errText = err?.message || String(err);
				if (errText.includes("PHONE_NUMBER_INVALID")) {
					logMessage.error(
						"Phone number is invalid. Use full international format, e.g. +14155552671."
					);
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
					logMessage.error(
						"Too many attempts. Telegram temporarily blocked new login attempts (FLOOD_WAIT)."
					);
					return;
				}
				logMessage.error(errText);
			},
		});

		logMessage.success("You should now be connected.");
		if (!sessionId) {
			sessionId = client.session.save();
			updateCredentials({ sessionId });
			logMessage.info(
				`To avoid login again and again session id has been saved to config.json, please don't share it with anyone`,
			);
		}

		return client;
	} catch (err) {
		logMessage.error(err);
	}
};

module.exports = {
	initAuth,
};
