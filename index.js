const fs = require("fs");
const path = require("path");
const paths = require("./utils/paths");

// Check if running validator mode
const args = process.argv.slice(2);

const takeOptionValue = (optionName) => {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex === -1) {
    return undefined;
  }

  const optionValue = args[optionIndex + 1];
  args.splice(optionIndex, optionValue !== undefined ? 2 : 1);
  return optionValue;
};

const runtimeOptions = {
  root: takeOptionValue("--root"),
  exportDir: takeOptionValue("--export-dir"),
  configFile: takeOptionValue("--config-file"),
  logsDir: takeOptionValue("--logs-dir"),
};

paths.configure(runtimeOptions);

const appPaths = {
  exportPath: paths.export,
};

// Parse --check and --deep-check flags (used during normal download to validate existing files)
const checkIndex = args.indexOf("--check");
const deepCheckIndex = args.indexOf("--deep-check");
const checkMode = deepCheckIndex !== -1 ? "deep" : (checkIndex !== -1 ? "fast" : "none");

// Remove check flags from args
if (checkIndex !== -1) args.splice(checkIndex, 1);
if (deepCheckIndex !== -1) args.splice(deepCheckIndex, 1);

// Parse --auto flag for non-interactive mode (accepts all defaults)
const autoMode = args.includes("--auto") || args.includes("-y");
if (autoMode) args.splice(args.indexOf(args.includes("--auto") ? "--auto" : "-y"), 1);

if (args[0] === "valid") {
    // Run validator module
    const { runValidation, parseArgs } = require("./validators");
    const logger = require("./utils/logger");
    const options = parseArgs();
    logger.init();
    // If --deep-check was passed with valid command, enable deep validation
    if (checkMode === "deep") {
        options.deep = true;
    }
    runValidation(options)
        .then((result) => {
            logger.close();
            process.exit(0);
        })
        .catch((err) => {
            logger.writeSync("error", `[VALID] Validation failed: ${err?.stack || err?.message || String(err)}`);
            console.error(`Validation failed: ${err.message}`);
            logger.close();
            process.exit(1);
        });
    return;
}

const { getMessages, startChannelListener, downloadMessagesByIds, rebuildDatabaseFromApi } = require("./modules/messages");
const { getLastSelection } = require("./utils/file_helper");
const { initAuth } = require("./modules/auth");
const { searchDialog, selectDialog, getDialogName, getAllDialogs} = require("./modules/dialoges");
const { logMessage, MEDIA_TYPES } = require("./utils/helper");
const logger = require("./utils/logger");

logger.init();

process.on('SIGINT', () => {
    logger.writeSync('info', 'Process interrupted (SIGINT), shutting down...');
    logger.close();
    process.exit(130);
});

process.on('SIGTERM', () => {
    logger.writeSync('info', 'Process terminated (SIGTERM), shutting down...');
    logger.close();
    process.exit(143);
});
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

const directRebuildChannelId = (() => {
  if (args[0] !== "rebuild-db") {
    return null;
  }

  const channelIdFromArgs = Number(args[1]);
  return Number.isFinite(channelIdFromArgs) && channelIdFromArgs !== 0
    ? channelIdFromArgs
    : null;
})();

// --- Main Menu ---
const showMainMenu = async () => {
  const choices = [
    { name: "Full Download (All messages with media)", value: "download" },
    { name: "Rebuild DB From API (No media download)", value: "rebuild_db" },
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
      const lastChannelName = await getDialogName(client, lastSelection.channelId, appPaths);
      logMessage.info(`Last selected channel: ${lastChannelName || lastSelection.channelId}`);
      const useLastChannel = await booleanInput("Do you want to continue with this channel?", true);
      
      if (!useLastChannel) {
        // Пользователь хочет выбрать другой канал
        const dialogs = await getAllDialogs(client, true, appPaths);
        await searchOrListChannel(dialogs);
        const newSelection = getLastSelection();
        selectedChannelId = newSelection.channelId;
      } else {
        selectedChannelId = lastSelection.channelId;
        logMessage.success(`Continuing with channel: ${lastChannelName || selectedChannelId}`);
      }
    } else {
      // Нет сохраненного выбора, предлагаем выбрать канал
      const dialogs = await getAllDialogs(client, true, appPaths);
      await searchOrListChannel(dialogs);
      const newSelection = getLastSelection();
      selectedChannelId = newSelection.channelId;
    }
  } else {
    logMessage.success(`Selected channel is: ${await getDialogName(client, selectedChannelId, appPaths)}`);
    const changeChannel = await booleanInput("Do you want to change channel?", false);
    if (changeChannel) {
      const dialogs = await getAllDialogs(client, true, appPaths);
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
  
  await getMessages(client, selectedChannelId, filesToDownload, { ...appPaths, check: checkMode !== "none", deep: checkMode === "deep" });
};

const resolveSelectedChannelId = async (client, chId) => {
  let selectedChannelId = chId;

  if (!selectedChannelId) {
    const lastSelection = getLastSelection();
    if (lastSelection.channelId) {
      const lastChannelName = await getDialogName(client, lastSelection.channelId, appPaths);
      logMessage.info(`Last selected channel: ${lastChannelName || lastSelection.channelId}`);
      const useLastChannel = await booleanInput("Do you want to continue with this channel?", true);

      if (!useLastChannel) {
        const dialogs = await getAllDialogs(client, true, appPaths);
        await searchOrListChannel(dialogs);
        const newSelection = getLastSelection();
        selectedChannelId = newSelection.channelId;
      } else {
        selectedChannelId = lastSelection.channelId;
        logMessage.success(`Continuing with channel: ${lastChannelName || selectedChannelId}`);
      }
    } else {
      const dialogs = await getAllDialogs(client, true, appPaths);
      await searchOrListChannel(dialogs);
      const newSelection = getLastSelection();
      selectedChannelId = newSelection.channelId;
    }
  }

  return selectedChannelId;
};

const runDatabaseRebuild = async (client, chId) => {
  const selectedChannelId = await resolveSelectedChannelId(client, chId);
  if (!selectedChannelId) {
    logMessage.error("Channel was not selected");
    return;
  }

  if (!client || typeof client.getMessages !== "function") {
    logMessage.error("Client is not properly initialized for DB rebuild");
    return;
  }

  // Warm up Telegram entity cache so direct numeric IDs can be resolved.
  await getAllDialogs(client, true, appPaths);

  await rebuildDatabaseFromApi(client, selectedChannelId, appPaths);
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

  await downloadMessagesByIds(client, channelIdNum, messageIds, appPaths);
};

// --- Auto mode: skip all prompts, use last channel or provided channelId ---
const runAutoMode = async (client, channelIdOverride) => {
  let selectedChannelId = channelIdOverride;

  if (!selectedChannelId) {
    const lastSelection = getLastSelection();
    if (lastSelection.channelId) {
      selectedChannelId = lastSelection.channelId;
      logMessage.success(`[AUTO] Using last channel: ${selectedChannelId}`);
    } else {
      logMessage.error("[AUTO] No channel ID provided and no last selection found. Use: npm start -- --auto <channelId>");
      return;
    }
  } else {
    logMessage.success(`[AUTO] Using channel: ${selectedChannelId}`);
  }

  const filesToDownload = {
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

  await getMessages(client, selectedChannelId, filesToDownload, { ...appPaths, check: checkMode !== "none", deep: checkMode === "deep" });
};

// --- Parse --auto channel ID ---
const autoChannelId = (() => {
  const autoIdx = process.argv.indexOf("--auto");
  const yIdx = process.argv.indexOf("-y");
  const hasAuto = autoIdx !== -1;
  const hasY = yIdx !== -1;

  if (!hasAuto && !hasY) return null;

  const flagIdx = hasAuto ? autoIdx : yIdx;
  const nextVal = process.argv[flagIdx + 1];
  const parsed = nextVal ? Number(nextVal) : NaN;
  if (Number.isFinite(parsed) && parsed !== 0) {
    return parsed;
  }
  return undefined;
})();

// Main Entry Point
(async () => {
  try {
    client = await initAuth();

    if (args[0] === "rebuild-db") {
      await runDatabaseRebuild(client, directRebuildChannelId);
      if (client) {
        await client.disconnect();
      }
      process.exit(0);
    }

    if (autoMode || autoChannelId !== null) {
      await runAutoMode(client, autoChannelId);
      if (client) {
        await client.disconnect();
      }
      process.exit(0);
    }

    // Show main menu and get choice
    const choice = await showMainMenu();

    switch (choice) {
      case "download":
        await runFullDownload(client, null);
        break;

      case "rebuild_db":
        await runDatabaseRebuild(client, null);
        break;

      case "listen":
        await startChannelListener(client, null, appPaths);
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
    const errorText = err?.stack || err?.message || String(err);
    logger.writeSync("error", `[MAIN] Unhandled error: ${errorText}`);
    console.error(err);
    logger.close();
    process.exit(1);
  }
})();
