const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isRetryableValidationError,
    shouldRetryDownload,
} = require('../services/DownloadManager');

const LARGE_FILE_SIZE = 256 * 1024 * 1024;
const SMALL_FILE_SIZE = 16 * 1024 * 1024;

test('isRetryableValidationError matches incomplete-download validation failures', () => {
    assert.equal(isRetryableValidationError('size mismatch: expected 100 bytes, got 50'), true);
    assert.equal(isRetryableValidationError('ffmpeg sampled decode: sample decode failed at 154.064s'), true);
    assert.equal(isRetryableValidationError('ffmpeg sampled decode: [NULL @ 1] Invalid NAL unit size (10 > 5).'), true);
    assert.equal(isRetryableValidationError('ffprobe exit code 1'), true);
    assert.equal(isRetryableValidationError('ffprobe: no duration found ()'), true);
    assert.equal(isRetryableValidationError('ffmpeg: [mjpeg @ 1] error y=146 x=3'), false);
});

test('shouldRetryDownload retries size mismatches regardless of size', () => {
    assert.equal(shouldRetryDownload('size mismatch: expected 100 bytes, got 50', null, SMALL_FILE_SIZE), true);
});

test('shouldRetryDownload retries large-file decode failures when expected size is known', () => {
    assert.equal(shouldRetryDownload('ffmpeg sampled decode: sample decode failed at 200.000s', LARGE_FILE_SIZE, null), true);
    assert.equal(shouldRetryDownload('ffprobe exit code 1', LARGE_FILE_SIZE, null), true);
});

test('shouldRetryDownload retries large-file decode failures when only observed size is known', () => {
    assert.equal(shouldRetryDownload('ffmpeg sampled decode: sample decode failed at 200.000s', null, LARGE_FILE_SIZE), true);
});

test('shouldRetryDownload does not retry small-file decode failures or non-retryable errors', () => {
    assert.equal(shouldRetryDownload('ffmpeg sampled decode: sample decode failed at 12.000s', null, SMALL_FILE_SIZE), false);
    assert.equal(shouldRetryDownload('ffmpeg: [mjpeg @ 1] error y=146 x=3', LARGE_FILE_SIZE, LARGE_FILE_SIZE), false);
});
