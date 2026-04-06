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

const { getMessages, startChannelListener, downloadMessagesByIds } = require("./modules/messages");
const { getLastSelection } = require("./utils/file_helper");
const { initAuth } = require("./modules/auth");
const { searchDialog, selectDialog, getDialogName, getAllDialogs} = require("./modules/dialoges");
const { logMessage, MEDIA_TYPES } = require("./utils/helper");
const {
  booleanInput,
  downloadOptionInput,
  textInput,
  selectInput,
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

// --- Main Menu ---
const showMainMenu = async () => {
  const choices = [
    { name: "Full Download (All messages with media)", value: "download" },
    { name: "Real-time Monitor (Listen for new messages)", value: "listen" },
    { name: "Download by IDs (Specific message IDs)", value: "download_ids" },
    { name: "Run File Validators", value: "valid" },
    { name: "Exit", value: "exit" },
  ];

  return await selectInput("Select an action:", choices);
};

// --- Search or List Channel ---
const searchOrListChannel = async (dialogs) => {
  const wantToSearch = await booleanInput("Do you want to search for a channel?", false);
  if (wantToSearch) {
    await searchDialog(dialogs);
  } else {
    await selectDialog(dialogs);
  }
};

// --- Download Full Channel ---
const runFullDownload = async (client, chId) => {
  let selectedChannelId = chId;

  if (!selectedChannelId) {
    // Проверяем, есть ли сохраненный выбор канала
    const lastSelection = getLastSelection();
    if (lastSelection.channelId) {
      const lastChannelName = await getDialogName(client, lastSelection.channelId);
      logMessage.info(`Last selected channel: ${lastChannelName || lastSelection.channelId}`);
      const useLastChannel = await booleanInput("Do you want to continue with this channel?", true);
      
      if (!useLastChannel) {
        // Пользователь хочет выбрать другой канал
        const dialogs = await getAllDialogs(client);
        await searchOrListChannel(dialogs);
        const newSelection = getLastSelection();
        selectedChannelId = newSelection.channelId;
      } else {
        selectedChannelId = lastSelection.channelId;
        logMessage.success(`Continuing with channel: ${lastChannelName || selectedChannelId}`);
      }
    } else {
      // Нет сохраненного выбора, предлагаем выбрать канал
      const dialogs = await getAllDialogs(client);
      await searchOrListChannel(dialogs);
      const newSelection = getLastSelection();
      selectedChannelId = newSelection.channelId;
    }
  } else {
    logMessage.success(`Selected channel is: ${await getDialogName(client, selectedChannelId)}`);
    const changeChannel = await booleanInput("Do you want to change channel?", false);
    if (changeChannel) {
      const dialogs = await getAllDialogs(client);
      await searchOrListChannel(dialogs);
      const newSelection = getLastSelection();
      selectedChannelId = newSelection.channelId;
    }
  }

  const filesToDownload = await downloadOptionInput();
  
  // Валидация клиента перед передачей
  if (!client) {
    logMessage.error('Client is null/undefined - authentication failed');
    return;
  }
  if (typeof client.getMessages !== 'function') {
    logMessage.error(`Client is not properly initialized - getMessages is ${typeof client.getMessages}`);
    return;
  }
  
  await getMessages(client, selectedChannelId, filesToDownload, { check: checkMode !== "none", deep: checkMode === "deep" });
};

// --- Download by IDs ---
const runDownloadByIds = async (client) => {
  const chIdInput = await textInput("Please Enter Channel ID: ");
  const channelIdNum = Number(chIdInput);
  if (!channelIdNum) {
    logMessage.error("Invalid Channel ID");
    return;
  }

  const messageIdsText = await textInput("Please Enter Message Id(s) (separated by comma): ");
  const messageIds = messageIdsText.split(",").map(Number).filter(id => !isNaN(id));

  if (messageIds.length === 0) {
    logMessage.error("No valid message IDs provided");
    return;
  }

  await downloadMessagesByIds(client, channelIdNum, messageIds);
};

// Main Entry Point
(async () => {
  try {
    client = await initAuth();

    // Show main menu and get choice
    const choice = await showMainMenu();

    switch (choice) {
      case "download":
        await runFullDownload(client, null);
        break;

      case "listen":
        await startChannelListener(client, null);
        // Keep the process running for listening mode
        logMessage.info("Listening for new messages... Press Ctrl+C to stop.");
        await new Promise(() => {}); // Infinite wait
        break;

      case "download_ids":
        await runDownloadByIds(client);
        break;

      case "valid":
        const { runValidation, parseArgs } = require("./validators");
        const options = parseArgs();
        if (checkMode === "deep") {
          options.deep = true;
        }
        await runValidation(options);
        break;

      case "exit":
        logMessage.info("Exiting...");
        break;

      default:
        logMessage.error("Unknown option selected");
    }

    if (client) {
      await client.disconnect();
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
