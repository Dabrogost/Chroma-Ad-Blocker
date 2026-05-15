const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const browserPrivacyCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'browserPrivacy.js'),
  'utf8'
).replace(/^export\s+/gm, '');

function createChromeSetting({ value = true, levelOfControl = 'controllable_by_this_extension' } = {}) {
  const calls = [];
  return {
    calls,
    get(details, callback) {
      calls.push({ method: 'get', details });
      callback({ value, levelOfControl });
    },
    set(details, callback) {
      calls.push({ method: 'set', details });
      value = details.value;
      callback();
    },
    clear(details, callback) {
      calls.push({ method: 'clear', details });
      value = undefined;
      callback();
    },
    readValue() {
      return value;
    }
  };
}

function loadSandbox(overrides = {}) {
  const settings = {
    thirdPartyCookiesAllowed: createChromeSetting(overrides.thirdPartyCookiesAllowed),
    doNotTrackEnabled: createChromeSetting(overrides.doNotTrackEnabled),
    adMeasurementEnabled: createChromeSetting(overrides.adMeasurementEnabled),
    topicsEnabled: createChromeSetting(overrides.topicsEnabled),
    fledgeEnabled: createChromeSetting(overrides.fledgeEnabled)
  };

  const sandbox = {
    chrome: {
      runtime: {},
      privacy: {
        websites: settings
      },
      storage: {
        onChanged: { addListener: () => {} }
      }
    },
    Promise,
    Error,
    Set,
    String,
    Object
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(browserPrivacyCode, sandbox);
  return { sandbox, settings };
}

test('browser privacy hardening', async (t) => {
  await t.test('sets supported privacy settings to hardened values when enabled', async () => {
    const { sandbox, settings } = loadSandbox();

    const result = await sandbox.syncBrowserPrivacyHardening({ browserPrivacyHardening: true });

    assert.strictEqual(result.ok, true);
    for (const setting of Object.values(settings)) {
      assert.strictEqual(setting.readValue(), false);
      assert.ok(setting.calls.some(call => call.method === 'set' && call.details.value === false));
      assert.ok(setting.calls.some(call => call.method === 'set' && call.details.scope === 'regular'));
    }
  });

  await t.test('clears extension control when disabled', async () => {
    const { sandbox, settings } = loadSandbox({
      thirdPartyCookiesAllowed: { value: false, levelOfControl: 'controlled_by_this_extension' },
      doNotTrackEnabled: { value: false, levelOfControl: 'controlled_by_this_extension' },
      adMeasurementEnabled: { value: false, levelOfControl: 'controlled_by_this_extension' },
      topicsEnabled: { value: false, levelOfControl: 'controlled_by_this_extension' },
      fledgeEnabled: { value: false, levelOfControl: 'controlled_by_this_extension' }
    });

    const result = await sandbox.syncBrowserPrivacyHardening({ browserPrivacyHardening: false });

    assert.strictEqual(result.ok, true);
    for (const setting of Object.values(settings)) {
      assert.ok(setting.calls.some(call => call.method === 'clear' && call.details.scope === 'regular'));
    }
  });

  await t.test('reports partial status when another controller prevents hardening', async () => {
    const { sandbox } = loadSandbox({
      thirdPartyCookiesAllowed: { value: true, levelOfControl: 'controlled_by_other_extensions' },
      doNotTrackEnabled: { value: false },
      adMeasurementEnabled: { value: false },
      topicsEnabled: { value: false },
      fledgeEnabled: { value: false }
    });

    const status = await sandbox.getBrowserPrivacyHardeningStatus({ browserPrivacyHardening: true });

    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.active, false);
    assert.strictEqual(status.partial, true);
    assert.strictEqual(status.hardenedCount, 4);
    assert.strictEqual(status.blockedCount, 1);
  });
});
