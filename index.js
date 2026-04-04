const fs = require("fs");
const path = require("path");

// Check if running validator mode
const args = process.argv.slice(2);

// Parse --check and --deep-check flags (used during normal download to validate existing files)
const checkIndex = args.indexOf("--check");
const deepCheckIndex = args.indexOf("--deep-check");
const checkMode = deepCheckIndex !== -1 ? "deep" : (checkIndex !== -1 ? "fast" : "none");

// Remove check flags from args
if (checkIndex !== -1) args.splice(checkIndex, 1);
if (deepCheckIndex !== -1) args.splice(deepCheckIndex, 1);

if (args[0] === "valid") {
    // Run validator module
    const { runValidation, parseArgs } = require("./validators");
    const options = parseArgs();
    // If --deep-check was passed with valid command, enable deep validation
    if (checkMode === "deep") {
        options.deep = true;
    }
    runValidation(options)
        .then((result) => {
            process.exit(0);
        })
        .catch((err) => {
            console.error(`Validation failed: ${err.message}`);
            process.exit(1);
        });
    return;
}

const { getMessages } = require("./modules/messages");
const { getLastSelection } = require("./utils/file_helper");
const { initAuth } = require("./modules/auth");
const { searchDialog, selectDialog, getDialogName, getAllDialogs} = require("./modules/dialoges");
const { logMessage, MEDIA_TYPES } = require("./utils/helper");
const {
  booleanInput,
  downloadOptionInput,
} = require("./utils/input_helper");

const channelId = "";
const downloadableFiles = {
  webpage: true,
  poll: true,
  geo: true,
  contact: true,
  venue: true,
  sticker: true,
  image: true,
  video: true,
  audio: true,
  pdf: true,
};

(async () => {
  try {
    await channelDownloader.handle({ channelId, downloadableFiles });
  } catch (err) {
    console.error(err);
  }
  client = await initAuth();
  const dialogs = await getAllDialogs(client);

  if (!channelId) {
    await searchOrListChannel(dialogs);
  } else {
    logMessage.success(`Selected channel is: ${getDialogName(channelId)}`);
    const changeChannel = await booleanInput("Do you want to change channel?", false);
    if (changeChannel) {
      await searchOrListChannel(dialogs);
    }
  }
  const downloadableFiles = await downloadOptionInput();
  await getMessages(client, channelId, downloadableFiles, { check: checkMode !== "none", deep: checkMode === "deep" });
  await client.disconnect();

  process.exit(0);
})();
