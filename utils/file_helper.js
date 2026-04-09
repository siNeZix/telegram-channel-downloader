const fs = require('fs');
const path = require('path');
const { logMessage } = require('./helper');
const paths = require('./paths');

const getConfigFile = () => paths.config;
const getLastSelectionFile = () => paths.lastSelection;

const ensureParentDir = (filePath) => {
    const dirPath = path.dirname(filePath);
    paths.ensureDir(dirPath);
};

const updateCredentials = (obj) => {
    try {
        const configFile = getConfigFile();
        ensureParentDir(configFile);
        let data = fs.readFileSync(configFile);
        let credentials = JSON.parse(data);
        credentials = { ...credentials, ...obj };
        fs.writeFileSync(configFile, JSON.stringify(credentials, null, 2));
        logMessage.info('Credentials updated successfully');
    }
    catch (err) {
        logMessage.error(err?.message || String(err));
    }
}

const getCredentials = () => {
    try {
        const configFile = getConfigFile();
        const data = fs.readFileSync(configFile);
        const credentials = JSON.parse(data);
        return credentials;
    }
    catch (err) {
        logMessage.error("Please add your credentials in config.json file, follow https://github.com/siNeZix/telegram-channel-downloader#setup for more info");
        process.exit(1);
    }
}


const getLastSelection = () => {
    try {
        const lastSelectionFile = getLastSelectionFile();
        const data = fs.readFileSync(lastSelectionFile);
        const last = JSON.parse(data);
        return last;
    }
    catch (err) {
        return {};
    }
}

const updateLastSelection = (object) => {
    try {
        const lastSelectionFile = getLastSelectionFile();
        ensureParentDir(lastSelectionFile);
        let last = getLastSelection();
        last = {
            ...last,
            ...object
        }

        fs.writeFileSync(lastSelectionFile, JSON.stringify(last, null, 2));
        logMessage.debug('Last selection updated');
    }
    catch (err) {
        logMessage.error(err?.message || String(err));
    }
}

module.exports = {
    updateCredentials,
    getLastSelection,
    updateLastSelection,
    getCredentials
}
