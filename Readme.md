# Telegram Channel Downloader

Telegram Channel Downloader is a Node.js application that allows you to scrape and download all media files and messages (in HTML and JSON format) from Telegram channels, groups, or users. This tool simplifies the process of archiving content from Telegram for offline viewing or storage.

## Prerequisites

Before you begin, ensure you have the following installed on your system:
*   **Node.js** (v12 or higher recommended)
*   **npm** or **yarn**

## Setup

1.  **Create a Telegram App**: Go to [https://my.telegram.org/apps](https://my.telegram.org/apps) and create a new application.
2.  **Get API Credentials**: After creating the app, copy the API ID and API Hash provided by Telegram.
3.  **Configure `config.json`**:
    In the root directory of the application, create a file named `config.json` and paste the following code:
    ```json
    {
        "apiId": YOUR_API_ID,
        "apiHash": "YOUR_API_HASH",
        "sessionId": ""
    }
    ```
    Replace `YOUR_API_ID` and `YOUR_API_HASH` with the values obtained in step 2. Keep the `sessionId` blank for now; it will be updated automatically after logging in for the first time.

## Usage

1.  **Install Dependencies**:
    ```bash
    npm install
    ```
2.  **Run the Script**:
    ```bash
    npm start
    ```
3.  **Login**: The script will prompt you to enter your phone number and the verification code sent to your Telegram account. This authentication is required for the first time you run the script.
4.  **Select Dialog**: The script will display a list of your recent dialogs. You can search and select the channel, group, or user you want to archive.
5.  **Wait for Download**: The script will start downloading all available media files and messages from the specified source. Depending on the size of the content, this process may take some time.
6.  **Access Downloaded Files**: Once the download is complete, you can find the downloaded media files in the `export/` directory.

## Export Formats

The application supports exporting messages in two formats:

### JSON Lines Format (Recommended)

The exported files use the **JSON Lines** format for optimized performance.

**Format:**
*   Each batch of messages is written as a separate line
*   Each line is a valid JSON array of message objects
*   Lines are separated by the newline character `\n`

**Example:**
```json
[{"id":1,"message":"text1","date":"2024-01-01"}]
[{"id":2,"message":"text2","date":"2024-01-02"}]
```

**Advantages:**
*   Write speed < 1 second (instead of 2-4 minutes)
*   Minimal memory usage
*   Independent of file size

**Reading Files:**

To read JSON Lines files, use the `readJSONLinesFile()` utility function:

```javascript
const { readJSONLinesFile } = require('./utils/helper');

const messages = readJSONLinesFile('path/to/raw_message.json');
console.log(`Total messages: ${messages.length}`);
```

### HTML Format

The application also generates an HTML file (`messages.html`) for easy viewing of the exported content in a web browser.

## Session Handling

The `sessionId` field in the `config.json` file will be automatically updated after logging in for the first time. This session ID is used for subsequent logins to avoid re-entering your credentials.

## Media Types

The Telegram Channel Downloader supports downloading various types of media files, including images, videos, audio files, documents, and other attachments.

## Available Scripts

*   `npm start` - Start the main downloader script.
*   `npm run dev` - Start the script with Nodemon for auto-reloading on changes.
*   `npm run save-files` - Re-run the file saving process (useful if previous saves were interrupted).
*   `npm run export-messages` - Re-run the message export process.
*   `npm run valid` - Run validators (e.g., FFmpeg validation).

## Contributing

Contributions are welcome! If you have any suggestions, bug reports, or feature requests, please open an issue or submit a pull request on GitHub.

## License

This project is licensed under the ISC License.
