/**
 * Serializes mutations of config and other settings replaced by a full import.
 * Callers that touch the same storage keys must share this queue so imports
 * cannot interleave with their read/modify/write cycles.
 */

'use strict';

const queue = [];
let activeTopLevel = false;
let nestedWindowDepth = 0;
let nestedRunning = false;
let nestedDrainWaiters = [];

function notifyNestedDrained() {
  if (nestedRunning) return;
  if (nestedWindowDepth > 0 && queue.some(item => item.isNestedCapable)) return;
  const waiters = nestedDrainWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function waitForNestedDrain() {
  if (!nestedRunning && !(nestedWindowDepth > 0 && queue.some(item => item.isNestedCapable))) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    nestedDrainWaiters.push(resolve);
  });
}

function pumpQueues() {
  if (activeTopLevel) {
    if (nestedWindowDepth > 0 && !nestedRunning) {
      const idx = queue.findIndex(item => item.isNestedCapable);
      if (idx !== -1) {
        const [nextNested] = queue.splice(idx, 1);
        nestedRunning = true;
        Promise.resolve()
          .then(nextNested.task)
          .then(nextNested.resolve, nextNested.reject)
          .finally(() => {
            nestedRunning = false;
            pumpQueues();
            notifyNestedDrained();
          });
      }
    }
    return;
  }

  if (nestedRunning || queue.length === 0) return;

  const next = queue.shift();
  activeTopLevel = true;
  Promise.resolve()
    .then(next.task)
    .then(next.resolve, next.reject)
    .finally(() => {
      activeTopLevel = false;
      pumpQueues();
    });
}

function enqueue(task, isNestedCapable) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject, isNestedCapable });
    pumpQueues();
  });
}

export function serializeConfigMutation(task) {
  return enqueue(task, false);
}

/**
 * Allows nested-capable storage mutations (such as proxy cleanup during
 * proxy reconciliation) to run while the caller holds the top-level queue.
 */
export async function allowNestedConfigMutations(task) {
  if (!activeTopLevel) {
    return task();
  }
  nestedWindowDepth++;
  pumpQueues();
  try {
    return await task();
  } finally {
    await waitForNestedDrain();
    nestedWindowDepth = Math.max(0, nestedWindowDepth - 1);
  }
}

serializeConfigMutation.allowNestedMutations = allowNestedConfigMutations;

/**
 * Applies a mutation to the latest stored config while holding the shared
 * config queue. Return null/undefined from the mutator to leave storage alone.
 */
export function mutateStoredConfig(mutator) {
  return enqueue(async () => {
    const { config = {} } = await chrome.storage.local.get('config');
    const nextConfig = await mutator(config);
    if (!nextConfig) return { changed: false, config };
    await chrome.storage.local.set({ config: nextConfig });
    return { changed: true, config: nextConfig };
  }, true);
}
