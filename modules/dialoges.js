const ejs = require('ejs');
const fs = require("fs");
const path = require('path');
const { updateLastSelection } = require("../utils/file_helper");
const { logMessage, getDialogType, circularStringify } = require("../utils/helper");
const { numberInput, textInput, booleanInput } = require('../utils/input_helper');
const paths = require('../utils/paths');

/**
 * Fetches all dialogs from the client, sorts them by name, and exports them to JSON and HTML files.
 * @param {Object} client - The client object to fetch dialogs from.
 * @param {boolean} [sortByName=true] - Whether to sort the dialogs by name.
 * @returns {Promise<Array>} - A promise that resolves to the list of dialogs.
 */
const getAllDialogs = async (client, sortByName = true) => {
    try {
        logMessage.dialog(`Fetching all dialogs, sortByName=${sortByName}`);
        const dialogs = await client.getDialogs();
        logMessage.dialog(`getDialogs returned ${dialogs.length} dialogs`);

        const startMap = Date.now();
        const dialogList = dialogs.map(d => ({
            deletedAccount: d.entity?.deleted,
            isBot: d.entity?.bot,
            username: d.entity?.username?.trim(),
            lastMessage: d.message?.message?.trim(),
            lastMessageTimestamp: d.message?.date,
            phone: d.entity?.phone,
            firstName: d.entity?.firstName?.trim(),
            lastName: d.entity?.lastName?.trim(),
            name: d.title?.trim(),
            id: d.id,
            type: getDialogType(d)
        }));
        logMessage.dialog(`Mapped ${dialogList.length} dialogs in ${Date.now() - startMap}ms`);

        if (sortByName) {
            const startSort = Date.now();
            dialogList.sort((a, b) => a.name.localeCompare(b.name));
            logMessage.dialog(`Sorted ${dialogList.length} dialogs by name in ${Date.now() - startSort}ms`);
        }

        const channelTemplateFile = path.resolve(__dirname, '../templates/channels.ejs');
        logMessage.dialog(`Rendering HTML template: ${channelTemplateFile}`);
        const renderedHtml = await ejs.renderFile(channelTemplateFile, { channels: dialogList });

        // Ensure export directory exists
        logMessage.dialog(`Ensuring export directory exists: ${paths.export}`);
        paths.ensureDir(paths.export);

        logMessage.dialog(`Writing dialog data to files`);
        fs.writeFileSync(path.join(paths.export, "raw_dialog_list.json"), circularStringify(dialogs, null, 2));
        fs.writeFileSync(path.join(paths.export, "dialog_list.html"), renderedHtml);
        fs.writeFileSync(paths.getDialogListPath(), JSON.stringify(dialogList, null, 2));
        logMessage.dialog(`Dialog data written successfully`);

        // Summary of dialog types
        const typeSummary = dialogList.reduce((acc, d) => {
            acc[d.type] = (acc[d.type] || 0) + 1;
            return acc;
        }, {});
        logMessage.dialog(`Dialog summary by type: ${JSON.stringify(typeSummary)}`);

        return dialogList;
    } catch (error) {
        logMessage.error(`[DIALOG] Failed to get dialogs: ${error.message}`);
        throw error;
    }
};

/**
 * Prompts the user to select a dialog from the list.
 * @param {Array} dialogs - The list of dialogs.
 * @returns {Promise<number>} - A promise that resolves to the selected dialog's ID.
 */
const userDialogSelection = async (dialogs) => {
    try {
        logMessage.dialog(`Prompting user to select dialog (1-${dialogs.length})`);
        const selectedChannelNumber = await numberInput(`Please select from above list (1-${dialogs.length}): `, 1, dialogs.length);

        if (selectedChannelNumber > dialogs.length) {
            logMessage.error("[DIALOG] Invalid Input: number exceeds dialog count");
            process.exit(0);
        }

        const selectedChannel = dialogs[selectedChannelNumber - 1];
        const channelId = selectedChannel.id;
        logMessage.dialog(`User selected: number=${selectedChannelNumber}, id=${channelId}, name=${selectedChannel.name}, type=${selectedChannel.type}`);
        logMessage.info(`Selected channel: ${selectedChannel.name}`);

        logMessage.dialog(`Updating last selection: channelId=${channelId}, messageOffsetId=0`);
        updateLastSelection({
            channelId: channelId,
            messageOffsetId: 0
        });

        return channelId;
    } catch (error) {
        logMessage.error(`[DIALOG] Failed to select dialog: ${error.message}`);
        throw error;
    }
};

/**
 * Displays the list of dialogs and prompts the user to select one.
 * @param {Array} dialogs - The list of dialogs.
 * @returns {Promise<number>} - A promise that resolves to the selected dialog's ID.
 */
const selectDialog = async (dialogs) => {
    logMessage.dialog(`Displaying ${dialogs.length} dialogs for selection`);
    dialogs.forEach((d, index) => {
        console.log(`${index + 1} - ${d.name}`);
    });
    
    return await userDialogSelection(dialogs);
};

/**
 * Prompts the user to search for a dialog by name.
 * @param {Array} dialogs - The list of dialogs.
 * @returns {Promise<number>} - A promise that resolves to the selected dialog's ID.
 */
const searchDialog = async (dialogs) => {
    try {
        logMessage.dialog(`Starting dialog search`);
        const searchString = await textInput('Please enter name of channel to search');
        logMessage.dialog(`Search string: "${searchString}"`);

        const searchStart = Date.now();
        const results = [];
        dialogs.forEach((d, index) => {
            if (d.name.toUpperCase().includes(searchString.toUpperCase())) {
                console.log(`${index + 1} - ${d.name}`);
                results.push({ index, name: d.name });
            }
        });
        logMessage.dialog(`Search found ${results.length} matches in ${Date.now() - searchStart}ms`);

        if (results.length > 0) {
            const foundWantedDialog = await booleanInput('Found channel? If answering with "no" you can search again');
            if (foundWantedDialog) {
                logMessage.dialog(`User confirmed found channel, proceeding to selection`);
                return await userDialogSelection(dialogs);
            } else {
                logMessage.dialog(`User wants to search again`);
                return await searchDialog(dialogs);
            }
        } else {
            logMessage.dialog(`No matches found, prompting to search again`);
            const tryAgain = await booleanInput('No channels found. Search again?');
            if (tryAgain) {
                return await searchDialog(dialogs);
            } else {
                logMessage.dialog(`User cancelled search, falling back to selectDialog`);
                return await selectDialog(dialogs);
            }
        }
    } catch (error) {
        logMessage.error(`[DIALOG] Failed to search dialog: ${error.message}`);
        throw error;
    }
};

/**
 * Searches through the dialogs for a given search string and logs the results.
 * @param {Array} dialogs - The list of dialogs.
 * @param {string} searchString - The search string.
 */
const searchThroughDialogsWithSearchString = (dialogs, searchString) => {
    logMessage.dialog(`searchThroughDialogsWithSearchString: searching for "${searchString}"`);
    const results = [];
    dialogs.forEach((d, index) => {
        if (d.name.toUpperCase().includes(searchString.toUpperCase())) {
            console.log(`${index + 1} - ${d.name}`);
            results.push(index);
        }
    });
    logMessage.dialog(`searchThroughDialogsWithSearchString found ${results.length} matches: indices=${JSON.stringify(results)}`);
};

/**
 * Retrieves the name of a dialog by its ID.
 * @param {number} channelId - The ID of the channel.
 * @returns {string|null} - The name of the dialog, or null if not found.
 */
const getDialogName = async (client, channelId) => {
    try {
        const dialogListPath = paths.getDialogListPath();
        logMessage.dialog(`getDialogName: looking for channelId=${channelId}, path=${dialogListPath}`);
        
        if (!fs.existsSync(dialogListPath)) {
            logMessage.dialog(`Dialog list not found at ${dialogListPath}, fetching from API`);
            await getAllDialogs(client);
            logMessage.dialog(`Dialog list fetched, exiting to reload`);
            process.exit(0);
        }

        const dialogs = require(dialogListPath);
        const dialog = dialogs.find(d => d.id == channelId);
        
        if (dialog) {
            logMessage.dialog(`getDialogName: found "${dialog.name}" for channelId=${channelId}`);
        } else {
            logMessage.dialog(`getDialogName: no dialog found for channelId=${channelId}`);
        }
        
        return dialog ? dialog.name : null;
    } catch (error) {
        logMessage.error(`[DIALOG] Failed to get dialog name: ${error.message}`);
        return null;
    }
};

module.exports = {
    getAllDialogs,
    selectDialog,
    searchDialog,
    getDialogName
};
