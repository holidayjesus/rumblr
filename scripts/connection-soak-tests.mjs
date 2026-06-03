import assert from 'node:assert/strict';

// This offline soak scaffold locks down the state transitions that real network soak tests will exercise.

const storage = new Map();
globalThis.window = {
  requestIdleCallback(callback) { callback({ didTimeout: false, timeRemaining: () => 50 }); return 1; },
  cancelIdleCallback() {},
};
globalThis.document = { querySelector: () => null };
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { state } = await import('../src/core/state.js');
const { recordNetworkTraffic, setRuntimeNetworkStatus, shouldReconcileLiveTraffic, connectionDetailMessage } = await import('../src/core/network-state.js');
const { compactUnreadMap, sessionStore } = await import('../src/core/persistence.js');
const { finishInteraction, getPerformanceSnapshot, measureTask, startInteraction } = await import('../src/core/performance.js');

state.config = { servers: [{ id: 'libera', name: 'Libera.Chat', autojoin: ['#rumblr', '#btrfs'] }] };
state.activeServer = 'libera';
state.activeChannel = '#rumblr';
state.unreads = { libera: { '#btrfs': 3, '#btrfs:mention': true } };
state.netStatus = {};
state.netDetails = {};

setRuntimeNetworkStatus(state, 'libera', 'online', 'Connected; keepalive acknowledged.');
assert.equal(connectionDetailMessage(state, 'libera', 'online'), 'Connected; keepalive acknowledged.');
assert.equal(shouldReconcileLiveTraffic(state, 'libera'), false);

setRuntimeNetworkStatus(state, 'libera', 'offline', 'Socket closed.');
assert.equal(shouldReconcileLiveTraffic(state, 'libera'), true);
const liveRepair = recordNetworkTraffic(state, 'libera');
assert.equal(liveRepair.reconciled, true);
assert.equal(state.netStatus.libera, 'online');
assert.equal(typeof state.netDetails.libera.last_rx_at, 'number');
assert.equal(shouldReconcileLiveTraffic(state, 'libera'), false);

setRuntimeNetworkStatus(state, 'libera', 'retrying', 'Retrying after backoff.');
sessionStore.saveRuntimeSession(state);
sessionStore.flush();
const savedRetry = JSON.parse(localStorage.getItem(sessionStore.keys.sessionState));
assert.deepEqual(savedRetry.openNetworks, ['libera']);
assert.equal(savedRetry.unreads.libera['#btrfs'], 3);
assert.deepEqual(
  compactUnreadMap({ libera: { '#btrfs': 0, '#btrfs:mention': true, '#rumblr': 1 } }),
  { libera: { '#rumblr': 1 } },
  'zero unread state should not survive soak persistence',
);

setRuntimeNetworkStatus(state, 'libera', 'online', 'Reconnected and rejoined channels.');
sessionStore.saveRuntimeSession(state);
sessionStore.flush();
const savedOnline = JSON.parse(localStorage.getItem(sessionStore.keys.sessionState));
assert.deepEqual(savedOnline.joinedBuffers.libera, ['#rumblr', '#btrfs']);
assert.equal(savedOnline.netDetails.libera.status, 'online');

measureTask('soak-buffer-switch', () => Array.from({ length: 1000 }, (_, index) => index).reduce((sum, value) => sum + value, 0));
assert.ok(getPerformanceSnapshot()['soak-buffer-switch'].count >= 1);
const interactionMark = startInteraction('soak-input', { channel: '#rumblr' });
finishInteraction(interactionMark, 'work');
assert.ok(getPerformanceSnapshot()['interaction:soak-input:work'].count >= 1);

console.log('Connection soak scaffold passed: live-traffic repair, idle status, retry persistence, channel restore, unread restore, and interaction timing.');
