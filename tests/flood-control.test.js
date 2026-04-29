const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../utils/config');
const { FloodControl } = require('../services/FloodControl');
const { logMessage } = require('../utils/helper');

const originalDownloadConfig = config.getSection('download');

const restoreDownloadConfig = () => {
    for (const [key, value] of Object.entries(originalDownloadConfig)) {
        config.set(`download.${key}`, value, false);
    }
};

const withMutedFloodLogs = async (fn) => {
    const originalError = logMessage.error;
    const originalFlood = logMessage.flood;
    logMessage.error = () => {};
    logMessage.flood = () => {};

    try {
        return await fn();
    } finally {
        logMessage.error = originalError;
        logMessage.flood = originalFlood;
    }
};

test.afterEach(() => {
    restoreDownloadConfig();
});

test('FloodControl.runWithFloodControl retries flood waits, lowers parallelism, and records cooldown', async () => {
    config.set('download.maxParallel', 4, false);
    config.set('download.minParallel', 2, false);
    config.set('download.baseRpcDelaySeconds', 0, false);

    const waits = [];
    let now = 1_000;
    let attempts = 0;

    const control = new FloodControl({
        waitFn: async (seconds) => {
            waits.push(seconds);
            now += seconds * 1000;
        },
        nowFn: () => now,
    });

    try {
        const result = await withMutedFloodLogs(async () => control.runWithFloodControl('download-test', async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('FLOOD_WAIT_3');
                error.seconds = 3;
                throw error;
            }
            return 'ok';
        }));

        assert.equal(result, 'ok');
        assert.equal(attempts, 2);
        assert.deepEqual(waits, [4]);
        assert.equal(control.currentParallelLimit, 3);
        assert.equal(control.consecutiveFloods, 1);
        assert.equal(control.successStreak, 1);
        assert.equal(control.cooldownUntil, 5_000);
    } finally {
        control.cleanup();
    }
});

test('FloodControl.runWithFloodControl increases parallel limit after sustained success', async () => {
    config.set('download.maxParallel', 5, false);
    config.set('download.baseRpcDelaySeconds', 0, false);

    const control = new FloodControl({
        waitFn: async () => {},
        nowFn: () => 1_000,
    });

    try {
        control.currentParallelLimit = 4;

        for (let index = 0; index < 30; index += 1) {
            const value = await withMutedFloodLogs(async () => control.runWithFloodControl('success-test', async () => 'ok'));
            assert.equal(value, 'ok');
        }

        assert.equal(control.currentParallelLimit, 5);
        assert.equal(control.successStreak, 0);
    } finally {
        control.cleanup();
    }
});

test('FloodControl.runWithFloodControl rethrows non-flood errors without mutating state', async () => {
    config.set('download.maxParallel', 4, false);
    config.set('download.baseRpcDelaySeconds', 0, false);

    const control = new FloodControl({
        waitFn: async () => {},
        nowFn: () => 1_000,
    });

    try {
        await assert.rejects(
            withMutedFloodLogs(async () => control.runWithFloodControl('non-flood-test', async () => {
                throw new Error('network timeout');
            })),
            /network timeout/
        );

        assert.equal(control.currentParallelLimit, 4);
        assert.equal(control.consecutiveFloods, 0);
        assert.equal(control.successStreak, 0);
        assert.equal(control.cooldownUntil, 0);
    } finally {
        control.cleanup();
    }
});

test('FloodControl reacts to config changes and can release its config listener', () => {
    config.set('download.maxParallel', 6, false);

    const control = new FloodControl({
        waitFn: async () => {},
        nowFn: () => 1_000,
    });

    try {
        control.currentParallelLimit = 6;
        config.set('download.maxParallel', 3, false);
        control.configListener(['download.maxParallel']);
        assert.equal(control.currentParallelLimit, 3);

        control.cleanup();
        assert.equal(control.removeConfigListener, null);
    } finally {
        if (control.removeConfigListener) {
            control.cleanup();
        }
    }
});

test('isFileReferenceExpired detects FILE_REFERENCE_EXPIRED errors', () => {
    const { isFileReferenceExpired } = require('../services/FloodControl');

    const err1 = new Error('400: FILE_REFERENCE_EXPIRED (caused by upload.GetFile)');
    assert.equal(isFileReferenceExpired(err1), true);

    const err2 = new Error('FILE_REFERENCE_X_EXPIRED');
    assert.equal(isFileReferenceExpired(err2), true);

    const err3 = new Error('FLOOD_WAIT_60');
    assert.equal(isFileReferenceExpired(err3), false);

    const err4 = new Error('network timeout');
    assert.equal(isFileReferenceExpired(err4), false);

    const err5 = { errorMessage: 'FILE_REFERENCE_EXPIRED', message: '' };
    assert.equal(isFileReferenceExpired(err5), true);
});

test('FloodControl.runWithFloodControl tags FILE_REFERENCE_EXPIRED errors with _isFileReferenceExpired', async () => {
    config.set('download.maxParallel', 4, false);
    config.set('download.baseRpcDelaySeconds', 0, false);

    const control = new FloodControl({
        waitFn: async () => {},
        nowFn: () => 1_000,
    });

    try {
        const err = await withMutedFloodLogs(async () =>
            control.runWithFloodControl('file-ref-test', async () => {
                const e = new Error('400: FILE_REFERENCE_EXPIRED (caused by upload.GetFile)');
                throw e;
            }).catch(e => e)
        );

        assert.equal(err._isFileReferenceExpired, true);
        assert.ok(err.message.includes('FILE_REFERENCE_EXPIRED'));
    } finally {
        control.cleanup();
    }
});
