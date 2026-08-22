/**
 * Central background message registration table.
 *
 * Handler implementations live in domain modules. Sender policy stays here so
 * every content-script exception remains visible and auditable in one place.
 */

'use strict';

import { MSG } from '../../core/messageTypes.js';
import { handleConfigGet, handleConfigSet } from './configHandlers.js';
import { handleConfigExport, handleConfigImport } from './settingsTransferHandlers.js';
import {
  handleWhitelistGet,
  handleWhitelistAdd,
  handleWhitelistRemove,
  handleFprWhitelistGet,
  handleFprWhitelistAdd,
  handleFprWhitelistRemove
} from './whitelistHandlers.js';
import {
  handleProxyConfigGet,
  handleProxyConfigSet,
  handleProxyTest
} from './proxyHandlers.js';
import {
  handleSubscriptionGet,
  handleSubscriptionSet,
  handleSubscriptionRefresh,
  handleSubscriptionAdd,
  handleSubscriptionRemove
} from './subscriptionHandlers.js';
import {
  handleUserScriptletsGet,
  handleUserScriptletSourceAdd,
  handleUserScriptletSourceRefresh,
  handleUserScriptletSourceRemove,
  handleUserScriptletRulesSet
} from './userScriptletHandlers.js';
import {
  handleZapperStart,
  handleZapperSaveRule,
  handleZapperRulesGet,
  handleZapperRuleRemove,
  handleZapperRuleSet
} from './zapperHandlers.js';
import {
  handleStatsGet,
  handleStatsEventBatch,
  handleStatsReset,
  handleStatsExport,
  handleStatsSettingsSet,
  handleLogGet,
  handleHealthGet,
  handleUpdateCheck,
  handleUpdatePackageInspect
} from './diagnosticHandlers.js';

export function registerAll(router) {
  router.registerHandler(MSG.CONFIG_GET,           handleConfigGet);
  router.registerHandler(MSG.CONFIG_SET,           handleConfigSet);
  router.registerHandler(MSG.CONFIG_EXPORT,        handleConfigExport);
  router.registerHandler(MSG.CONFIG_IMPORT,        handleConfigImport);
  router.registerHandler(MSG.STATS_GET,            handleStatsGet);
  router.registerHandler(MSG.STATS_EVENT_BATCH,    handleStatsEventBatch, { allowContentScripts: true });
  router.registerHandler(MSG.WHITELIST_GET,        handleWhitelistGet);
  router.registerHandler(MSG.WHITELIST_ADD,        handleWhitelistAdd);
  router.registerHandler(MSG.WHITELIST_REMOVE,     handleWhitelistRemove);
  router.registerHandler(MSG.FPR_WHITELIST_GET,    handleFprWhitelistGet);
  router.registerHandler(MSG.FPR_WHITELIST_ADD,    handleFprWhitelistAdd);
  router.registerHandler(MSG.FPR_WHITELIST_REMOVE, handleFprWhitelistRemove);
  router.registerHandler(MSG.PROXY_CONFIG_GET,     handleProxyConfigGet);
  router.registerHandler(MSG.PROXY_CONFIG_SET,     handleProxyConfigSet);
  router.registerHandler(MSG.PROXY_TEST,           handleProxyTest);
  router.registerHandler(MSG.ZAPPER_START,         handleZapperStart);
  router.registerHandler(MSG.ZAPPER_SAVE_RULE,     handleZapperSaveRule, { allowContentScripts: true });
  router.registerHandler(MSG.ZAPPER_RULES_GET,     handleZapperRulesGet);
  router.registerHandler(MSG.ZAPPER_RULE_REMOVE,   handleZapperRuleRemove);
  router.registerHandler(MSG.ZAPPER_RULE_SET,      handleZapperRuleSet);
  router.registerHandler(MSG.SUBSCRIPTION_GET,     handleSubscriptionGet);
  router.registerHandler(MSG.SUBSCRIPTION_SET,     handleSubscriptionSet);
  router.registerHandler(MSG.SUBSCRIPTION_REFRESH, handleSubscriptionRefresh);
  router.registerHandler(MSG.SUBSCRIPTION_ADD,     handleSubscriptionAdd);
  router.registerHandler(MSG.SUBSCRIPTION_REMOVE,  handleSubscriptionRemove);
  router.registerHandler(MSG.USER_SCRIPTLETS_GET, handleUserScriptletsGet);
  router.registerHandler(MSG.USER_SCRIPTLET_SOURCE_ADD, handleUserScriptletSourceAdd);
  router.registerHandler(MSG.USER_SCRIPTLET_SOURCE_REFRESH, handleUserScriptletSourceRefresh);
  router.registerHandler(MSG.USER_SCRIPTLET_SOURCE_REMOVE, handleUserScriptletSourceRemove);
  router.registerHandler(MSG.USER_SCRIPTLET_RULES_SET, handleUserScriptletRulesSet);
  router.registerHandler(MSG.STATS_RESET,          handleStatsReset);
  router.registerHandler(MSG.STATS_EXPORT,         handleStatsExport);
  router.registerHandler(MSG.STATS_SETTINGS_SET,   handleStatsSettingsSet);
  router.registerHandler(MSG.LOG_GET,              handleLogGet);
  router.registerHandler(MSG.HEALTH_GET,           handleHealthGet);
  router.registerHandler(MSG.UPDATE_CHECK,         handleUpdateCheck);
  router.registerHandler(MSG.UPDATE_PACKAGE_INSPECT, handleUpdatePackageInspect);
}
