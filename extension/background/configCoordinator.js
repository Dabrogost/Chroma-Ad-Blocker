/**
 * Serializes every read/modify/write mutation of the shared config object.
 */

'use strict';

let configMutationTail = Promise.resolve();

export function serializeConfigMutation(task) {
  const run = configMutationTail.then(task);
  configMutationTail = run.catch(() => {});
  return run;
}

/**
 * Applies a mutation to the latest stored config while holding the shared
 * config queue. Return null/undefined from the mutator to leave storage alone.
 */
export function mutateStoredConfig(mutator) {
  return serializeConfigMutation(async () => {
    const { config = {} } = await chrome.storage.local.get('config');
    const nextConfig = await mutator(config);
    if (!nextConfig) return { changed: false, config };
    await chrome.storage.local.set({ config: nextConfig });
    return { changed: true, config: nextConfig };
  });
}
