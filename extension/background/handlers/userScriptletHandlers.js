/**
 * Advanced user-scriptlet message handlers.
 */

'use strict';

import {
  addUserScriptletSource,
  getUserScriptletSettings,
  refreshUserScriptletSource,
  removeUserScriptletSource,
  setUserScriptletRuleText
} from '../../scriptlets/userResources.js';
import { syncUserScripts } from '../../scriptlets/engine.js';

const USER_SCRIPTLET_SOURCE_ID_RE = /^[a-z0-9_-]{1,96}$/i;

function isValidUserScriptletSourceId(id) {
  return typeof id === 'string' && USER_SCRIPTLET_SOURCE_ID_RE.test(id);
}

async function syncUserScriptsAfterMutation(result) {
  if (result?.ok) await syncUserScripts();
  return result;
}

export async function handleUserScriptletsGet() {
  return getUserScriptletSettings();
}

export async function handleUserScriptletSourceAdd(msg) {
  return syncUserScriptsAfterMutation(await addUserScriptletSource(msg?.source || {}));
}

export async function handleUserScriptletSourceRefresh(msg) {
  if (!isValidUserScriptletSourceId(msg?.id)) return { ok: false, error: 'Invalid user scriptlet resource ID' };
  return syncUserScriptsAfterMutation(await refreshUserScriptletSource(msg.id));
}

export async function handleUserScriptletSourceRemove(msg) {
  if (!isValidUserScriptletSourceId(msg?.id)) return { ok: false, error: 'Invalid user scriptlet resource ID' };
  return syncUserScriptsAfterMutation(await removeUserScriptletSource(msg.id));
}

export async function handleUserScriptletRulesSet(msg) {
  return syncUserScriptsAfterMutation(await setUserScriptletRuleText(typeof msg?.ruleText === 'string' ? msg.ruleText : ''));
}
