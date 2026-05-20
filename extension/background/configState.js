/**
 * Shared background configuration validation.
 */

'use strict';

export function validateConfig(inputConfig) {
  const allowed = ['networkBlocking', 'stripping', 'acceleration', 'cosmetic', 'hideShorts', 'hideMerch', 'hideOffers', 'suppressWarnings', 'accelerationSpeed', 'enabled', 'globalProxyEnabled', 'globalProxyId', 'chromeServiceProxyBypass', 'webRtcLeakProtection', 'fingerprintRandomization', 'browserPrivacyHardening', 'geolocationProtection', 'trackingUrlCleanup', 'deAmpLinks'];
  const webRtcModes = new Set(['off', 'auto', 'balanced', 'strict']);
  const validatedConfig = {};

  if (inputConfig && typeof inputConfig === 'object') {
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(inputConfig, key)) {
        const val = inputConfig[key];
        if (key === 'accelerationSpeed') {
          if (typeof val === 'number' && val > 0 && val <= 16) {
            validatedConfig[key] = val;
          }
        } else if (key === 'globalProxyId') {
          if (val === null || typeof val === 'number') {
            validatedConfig[key] = val;
          }
        } else if (key === 'webRtcLeakProtection') {
          if (webRtcModes.has(val)) {
            validatedConfig[key] = val;
          }
        } else if (typeof val === 'boolean') {
          validatedConfig[key] = val;
        }
      }
    }
  }

  return validatedConfig;
}
