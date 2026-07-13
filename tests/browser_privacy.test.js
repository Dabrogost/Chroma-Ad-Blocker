const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const browserPrivacyCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'browserPrivacy.js'),
  'utf8'
).replace(/^export\s+/gm, '');

function createChromeSetting({
  value = true,
  levelOfControl = 'controllable_by_this_extension',
  defaultValue = true,
  getError = null,
  emitOwnChanges = false
} = {}) {
  const calls = [];
  let changeListener = null;
  return {
    calls,
    get(details, callback) {
      calls.push({ method: 'get', details });
      if (getError) throw getError;
      callback({ value, levelOfControl });
    },
    set(details, callback) {
      calls.push({ method: 'set', details });
      value = details.value;
      levelOfControl = 'controlled_by_this_extension';
      if (emitOwnChanges) changeListener?.({ value, levelOfControl });
      callback();
    },
    clear(details, callback) {
      calls.push({ method: 'clear', details });
      value = defaultValue;
      levelOfControl = 'controllable_by_this_extension';
      if (emitOwnChanges) changeListener?.({ value, levelOfControl });
      callback();
    },
    onChange: {
      addListener(listener) {
        changeListener = listener;
      }
    },
    emitChange(next = {}) {
      if (Object.prototype.hasOwnProperty.call(next, 'value')) value = next.value;
      if (next.levelOfControl) levelOfControl = next.levelOfControl;
      changeListener?.({ value, levelOfControl });
    },
    readValue() {
      return value;
    },
    readLevel() {
      return levelOfControl;
    }
  };
}

function createContentSetting({ setting = 'ask', getError = null } = {}) {
  const calls = [];
  return {
    calls,
    get(details, callback) {
      calls.push({ method: 'get', details });
      if (getError) throw getError;
      callback({ setting });
    },
    set(details, callback) {
      calls.push({ method: 'set', details });
      setting = details.setting;
      callback();
    },
    clear(details, callback) {
      calls.push({ method: 'clear', details });
      setting = undefined;
      callback();
    },
    readSetting() {
      return setting;
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
  const contentSettings = {
    location: createContentSetting(overrides.location)
  };
  const storage = {
    config: overrides.config
  };
  let storageChangeListener = null;

  const sandbox = {
    chrome: {
      runtime: {},
      privacy: {
        websites: settings
      },
      contentSettings,
      storage: {
        local: {
          get: async key => {
            if (overrides.storageGetError) throw overrides.storageGetError;
            if (typeof key === 'string') return { [key]: storage[key] };
            const result = {};
            for (const item of key || []) result[item] = storage[item];
            return result;
          }
        },
        onChanged: { addListener: listener => { storageChangeListener = listener; } }
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
  return {
    sandbox,
    settings,
    contentSettings,
    storage,
    emitStorageConfig(config) {
      const oldValue = storage.config;
      storage.config = config;
      storageChangeListener?.({ config: { oldValue, newValue: config } }, 'local');
    }
  };
}

async function flushAsyncWork(turns = 12) {
  for (let index = 0; index < turns; index++) {
    await new Promise(resolve => setImmediate(resolve));
  }
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

  await t.test('sets Chrome geolocation content setting to block when enabled', async () => {
    const { sandbox, contentSettings } = loadSandbox();

    const result = await sandbox.syncGeolocationProtection({ geolocationProtection: true });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(contentSettings.location.readSetting(), 'block');
    assert.ok(contentSettings.location.calls.some(call =>
      call.method === 'set' &&
      call.details.primaryPattern === '<all_urls>' &&
      call.details.secondaryPattern === '<all_urls>' &&
      call.details.scope === 'regular' &&
      call.details.setting === 'block'
    ));
  });

  await t.test('clears Chrome geolocation content setting when disabled', async () => {
    const { sandbox, contentSettings } = loadSandbox({
      location: { setting: 'block' }
    });

    const result = await sandbox.syncGeolocationProtection({ geolocationProtection: false });

    assert.strictEqual(result.ok, true);
    assert.ok(contentSettings.location.calls.some(call => call.method === 'clear' && call.details.scope === 'regular'));
  });

  await t.test('reports geolocation protection status from Chrome content settings', async () => {
    const { sandbox } = loadSandbox({
      location: { setting: 'block' }
    });

    const status = await sandbox.getGeolocationProtectionStatus({ geolocationProtection: true });

    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.effective, true);
    assert.strictEqual(status.setting, 'block');
  });

  await t.test('master off clears requested browser privacy and geolocation controls', async () => {
    const controlled = { value: false, levelOfControl: 'controlled_by_this_extension' };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: controlled,
      doNotTrackEnabled: controlled,
      adMeasurementEnabled: controlled,
      topicsEnabled: controlled,
      fledgeEnabled: controlled,
      location: { setting: 'block' }
    });
    const config = {
      enabled: false,
      browserPrivacyHardening: true,
      geolocationProtection: true
    };

    const [privacyResult, geoResult] = await Promise.all([
      harness.sandbox.syncBrowserPrivacyHardening(config),
      harness.sandbox.syncGeolocationProtection(config)
    ]);
    assert.strictEqual(privacyResult.requested, true);
    assert.strictEqual(privacyResult.enabled, false);
    assert.strictEqual(geoResult.requested, true);
    assert.strictEqual(geoResult.enabled, false);
    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.readLevel(), 'controllable_by_this_extension');
      assert.ok(setting.calls.some(call => call.method === 'clear'));
    }
    assert.ok(harness.contentSettings.location.calls.some(call => call.method === 'clear'));

    const privacyStatus = await harness.sandbox.getBrowserPrivacyHardeningStatus(config);
    const geoStatus = await harness.sandbox.getGeolocationProtectionStatus(config);
    assert.strictEqual(privacyStatus.requested, true);
    assert.strictEqual(privacyStatus.enabled, false);
    assert.strictEqual(privacyStatus.effective, false);
    assert.strictEqual(geoStatus.requested, true);
    assert.strictEqual(geoStatus.enabled, false);
    assert.strictEqual(geoStatus.effective, false);
  });

  await t.test('master-off status reports lingering Chroma ownership independently', async () => {
    const controlled = { value: false, levelOfControl: 'controlled_by_this_extension' };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: controlled,
      doNotTrackEnabled: controlled,
      adMeasurementEnabled: controlled,
      topicsEnabled: controlled,
      fledgeEnabled: controlled
    });
    const status = await harness.sandbox.getBrowserPrivacyHardeningStatus({
      enabled: false,
      browserPrivacyHardening: true
    });
    assert.strictEqual(status.requested, true);
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.effective, false);
    assert.strictEqual(status.controlled, true);
    assert.strictEqual(status.controlledCount, 5);
  });

  await t.test('master re-enable restores requested browser privacy and geolocation controls', async () => {
    const harness = loadSandbox();
    const off = { enabled: false, browserPrivacyHardening: true, geolocationProtection: true };
    const on = { ...off, enabled: true };

    await Promise.all([
      harness.sandbox.syncBrowserPrivacyHardening(off),
      harness.sandbox.syncGeolocationProtection(off)
    ]);
    await Promise.all([
      harness.sandbox.syncBrowserPrivacyHardening(on),
      harness.sandbox.syncGeolocationProtection(on)
    ]);

    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.readValue(), false);
      assert.strictEqual(setting.readLevel(), 'controlled_by_this_extension');
    }
    assert.strictEqual(harness.contentSettings.location.readSetting(), 'block');
    const status = await harness.sandbox.getBrowserPrivacyHardeningStatus(on);
    assert.strictEqual(status.requested, true);
    assert.strictEqual(status.controlled, true);
    assert.strictEqual(status.effective, true);
  });

  await t.test('external privacy control is degraded even when its value already matches', async () => {
    const external = { value: false, levelOfControl: 'controlled_by_other_extensions' };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: external,
      doNotTrackEnabled: external,
      adMeasurementEnabled: external,
      topicsEnabled: external,
      fledgeEnabled: external
    });
    const config = { enabled: true, browserPrivacyHardening: true };

    const result = await harness.sandbox.syncBrowserPrivacyHardening(config);
    const status = await harness.sandbox.getBrowserPrivacyHardeningStatus(config);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(status.effective, true);
    assert.strictEqual(status.controlled, false);
    assert.strictEqual(status.blockedCount, 5);
    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.calls.some(call => call.method === 'set'), false);
    }
  });

  await t.test('releasing external ChromeSetting control automatically reapplies stored intent', async () => {
    const external = { value: true, levelOfControl: 'controlled_by_other_extensions' };
    const config = { enabled: true, browserPrivacyHardening: true };
    const harness = loadSandbox({
      config,
      thirdPartyCookiesAllowed: external,
      doNotTrackEnabled: external,
      adMeasurementEnabled: external,
      topicsEnabled: external,
      fledgeEnabled: external
    });
    await harness.sandbox.syncBrowserPrivacyHardening(config);

    for (const setting of Object.values(harness.settings)) {
      setting.emitChange({ value: false, levelOfControl: 'controllable_by_this_extension' });
    }
    await flushAsyncWork();

    const status = await harness.sandbox.getBrowserPrivacyHardeningStatus(config);
    assert.strictEqual(status.controlled, true);
    assert.strictEqual(status.effective, true);
    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.readValue(), false);
      assert.ok(setting.calls.some(call => call.method === 'set'));
    }

    const setCounts = Object.values(harness.settings).map(setting =>
      setting.calls.filter(call => call.method === 'set').length
    );
    for (const setting of Object.values(harness.settings)) {
      setting.emitChange({ value: false, levelOfControl: 'controlled_by_this_extension' });
    }
    await flushAsyncWork();
    assert.deepStrictEqual(
      Object.values(harness.settings).map(setting => setting.calls.filter(call => call.method === 'set').length),
      setCounts,
      'own matching onChange events must reconcile idempotently'
    );
  });

  await t.test('rapid privacy and geolocation toggles converge to the latest master state', async () => {
    const controlled = { value: false, levelOfControl: 'controlled_by_this_extension' };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: controlled,
      doNotTrackEnabled: controlled,
      adMeasurementEnabled: controlled,
      topicsEnabled: controlled,
      fledgeEnabled: controlled,
      location: { setting: 'block' }
    });
    const on = { enabled: true, browserPrivacyHardening: true, geolocationProtection: true };
    const off = { ...on, enabled: false };
    await Promise.all([
      harness.sandbox.syncBrowserPrivacyHardening(on),
      harness.sandbox.syncBrowserPrivacyHardening(off),
      harness.sandbox.syncGeolocationProtection(on),
      harness.sandbox.syncGeolocationProtection(off)
    ]);

    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.readLevel(), 'controllable_by_this_extension');
    }
    assert.notStrictEqual(harness.contentSettings.location.readSetting(), 'block');
  });

  await t.test('own ChromeSetting onChange events do not stale the foreground reconciliation', async () => {
    const ownEvents = { value: true, emitOwnChanges: true };
    const config = { enabled: true, browserPrivacyHardening: true };
    const harness = loadSandbox({
      config,
      thirdPartyCookiesAllowed: ownEvents,
      doNotTrackEnabled: ownEvents,
      adMeasurementEnabled: ownEvents,
      topicsEnabled: ownEvents,
      fledgeEnabled: ownEvents
    });

    const result = await harness.sandbox.syncBrowserPrivacyHardening(config);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stale, false);
    assert.strictEqual(result.results.length, 5);
    const immediateStatus = await harness.sandbox.getBrowserPrivacyHardeningStatus(config);
    assert.strictEqual(immediateStatus.controlledCount, 5);
    assert.strictEqual(immediateStatus.effective, true);
    await flushAsyncWork();
  });

  await t.test('master off still clears Chrome privacy settings when inspection fails', async () => {
    const unreadable = {
      value: false,
      levelOfControl: 'controlled_by_this_extension',
      getError: new Error('inspection failed')
    };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: unreadable,
      doNotTrackEnabled: unreadable,
      adMeasurementEnabled: unreadable,
      topicsEnabled: unreadable,
      fledgeEnabled: unreadable
    });

    const result = await harness.sandbox.syncBrowserPrivacyHardening({
      enabled: false,
      browserPrivacyHardening: true
    });
    assert.strictEqual(result.ok, false, 'release is applied but cannot be verified');
    for (const setting of Object.values(harness.settings)) {
      assert.ok(setting.calls.some(call => call.method === 'clear'));
      assert.strictEqual(setting.readLevel(), 'controllable_by_this_extension');
    }
  });

  await t.test('enabled geolocation installs its own global rule even when the sampled value is already block', async () => {
    const harness = loadSandbox({ location: { setting: 'block' } });
    const result = await harness.sandbox.syncGeolocationProtection({
      enabled: true,
      geolocationProtection: true
    });
    assert.strictEqual(result.ok, true);
    assert.ok(harness.contentSettings.location.calls.some(call => call.method === 'set'));
  });

  await t.test('master off clears geolocation even when effective-value inspection fails', async () => {
    const harness = loadSandbox({
      location: { setting: 'block', getError: new Error('location inspection failed') }
    });
    const result = await harness.sandbox.syncGeolocationProtection({
      enabled: false,
      geolocationProtection: true
    });
    assert.strictEqual(result.ok, false);
    assert.ok(harness.contentSettings.location.calls.some(call => call.method === 'clear'));
    assert.notStrictEqual(harness.contentSettings.location.readSetting(), 'block');
  });

  await t.test('inspection failures are reported unavailable instead of as effective state', async () => {
    const unreadable = { getError: new Error('inspection failed') };
    const harness = loadSandbox({
      thirdPartyCookiesAllowed: unreadable,
      doNotTrackEnabled: unreadable,
      adMeasurementEnabled: unreadable,
      topicsEnabled: unreadable,
      fledgeEnabled: unreadable,
      location: { getError: new Error('location inspection failed') }
    });
    const config = {
      enabled: true,
      browserPrivacyHardening: true,
      geolocationProtection: true
    };
    const privacy = await harness.sandbox.getBrowserPrivacyHardeningStatus(config);
    const geolocation = await harness.sandbox.getGeolocationProtectionStatus(config);
    assert.strictEqual(privacy.available, false);
    assert.strictEqual(privacy.effective, false);
    assert.strictEqual(geolocation.available, false);
    assert.strictEqual(geolocation.effective, false);
  });

  await t.test('privacy recovery storage failure cannot clear existing controls', async () => {
    const controlled = { value: false, levelOfControl: 'controlled_by_this_extension' };
    const harness = loadSandbox({
      storageGetError: new Error('storage unavailable'),
      thirdPartyCookiesAllowed: controlled,
      doNotTrackEnabled: controlled,
      adMeasurementEnabled: controlled,
      topicsEnabled: controlled,
      fledgeEnabled: controlled,
      location: { setting: 'block' }
    });
    await assert.rejects(() => harness.sandbox.recoverBrowserPrivacyControls(), /storage unavailable/);
    for (const setting of Object.values(harness.settings)) {
      assert.strictEqual(setting.calls.some(call => call.method === 'clear'), false);
    }
    assert.strictEqual(harness.contentSettings.location.calls.some(call => call.method === 'clear'), false);
  });
});
