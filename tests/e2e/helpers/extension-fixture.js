const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const extensionRoot = path.join(repoRoot, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const expectedRulesets = manifest.declarative_net_request.rule_resources
  .filter(resource => resource.enabled)
  .map(resource => resource.id)
  .sort();

function findChrome() {
  const candidates = [
    process.env.CHROME_FOR_TESTING_PATH,
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe',
    'C:\\chrome-win64\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function isOfficialBrandedChrome(chromePath) {
  const normalized = chromePath.toLowerCase();
  return normalized.includes('\\google\\chrome\\application\\chrome.exe') &&
    !normalized.includes('chrome for testing');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpConnection {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data);
        if (!msg.id) return;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function getTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  }, sessionId);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.exception?.value || details.text || 'Runtime.evaluate failed');
  }
  return result.result.value;
}

async function loadExtensionViaCdp(cdp, extensionPath) {
  try {
    return await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  } catch (err) {
    return { error: err.message };
  }
}

async function findExtensionWorker(cdp, stderr) {
  try {
    return await waitFor(async () => {
      const targets = await getTargets(cdp);
      const workers = targets.filter(target =>
        target.type === 'service_worker' &&
        /^chrome-extension:\/\/[^/]+\//.test(target.url)
      );

      for (const worker of workers) {
        const sessionId = await attach(cdp, worker.targetId);
        const name = await evaluate(cdp, sessionId, 'chrome.runtime.getManifest().name');
        if (name === manifest.name) return { worker, sessionId };
        await cdp.send('Target.detachFromTarget', { sessionId });
      }
      return null;
    }, 'extension service worker');
  } catch (err) {
    const targets = await getTargets(cdp);
    const targetSummary = targets.map(target => `${target.type}:${target.url}`).join('\n');
    const workerDiagnostics = [];
    for (const target of targets.filter(item => item.type === 'service_worker')) {
      try {
        const sessionId = await attach(cdp, target.targetId);
        const workerManifest = await evaluate(cdp, sessionId, 'chrome.runtime.getManifest()');
        workerDiagnostics.push(`${target.url} => ${workerManifest.name}`);
        await cdp.send('Target.detachFromTarget', { sessionId });
      } catch (diagErr) {
        workerDiagnostics.push(`${target.url} => ${diagErr.message}`);
      }
    }
    throw new Error(`${err.message}\nChrome targets:\n${targetSummary}\nWorker diagnostics:\n${workerDiagnostics.join('\n')}\nChrome stderr:\n${stderr()}`);
  }
}

async function startChrome() {
  const chromePath = findChrome();
  assert.ok(chromePath, 'Chrome/Chromium executable should be available; set CHROME_BIN, CHROME_FOR_TESTING_PATH, or CHROME_PATH if it is installed elsewhere');
  assert.ok(
    !isOfficialBrandedChrome(chromePath) || process.env.CHROMA_E2E_ALLOW_BRANDED_CHROME === '1',
    [
      'E2E needs Chrome for Testing or Chromium because official branded Chrome no longer supports --load-extension.',
      `Selected browser: ${chromePath}`,
      'Install Chrome for Testing or Chromium and set CHROME_FOR_TESTING_PATH, CHROME_BIN, or CHROME_PATH to its chrome.exe.'
    ].join('\n')
  );

  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-extension-e2e-'));
  const extensionUnderTest = path.join(profileRoot, 'extension');
  fs.cpSync(extensionRoot, extensionUnderTest, { recursive: true });
  const args = [
    `--user-data-dir=${profileRoot}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${extensionUnderTest.replace(/\\/g, '/')}`,
    'about:blank'
  ];
  if (process.env.CHROMA_E2E_HEADLESS !== '0') {
    args.splice(2, 0, '--headless=new');
  } else {
    args.splice(2, 0, '--window-size=1200,900', '--window-position=-32000,-32000');
  }

  if (process.platform === 'linux') {
    args.splice(2, 0, '--no-sandbox', '--disable-dev-shm-usage');
  }

  const chrome = childProcess.spawn(chromePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  chrome.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const activePortPath = path.join(profileRoot, 'DevToolsActivePort');
  const portText = await waitFor(() => {
    if (!fs.existsSync(activePortPath)) return null;
    return fs.readFileSync(activePortPath, 'utf8');
  }, 'DevToolsActivePort');
  const [port] = portText.trim().split(/\r?\n/);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(res => res.json());
  const cdp = new CdpConnection(version.webSocketDebuggerUrl);
  await cdp.open();

  return {
    chrome,
    cdp,
    chromePath,
    extensionUnderTest,
    stderr: () => stderr,
    cleanup: async () => {
      try {
        cdp.close();
      } catch {}
      if (chrome.exitCode === null && !chrome.killed) {
        chrome.kill();
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 2000);
          chrome.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  };
}

async function startExtensionBrowser() {
  const browser = await startChrome();
  let foundWorker;
  try {
    foundWorker = await findExtensionWorker(browser.cdp, browser.stderr);
  } catch (initialErr) {
    const loaded = await loadExtensionViaCdp(browser.cdp, browser.extensionUnderTest);
    if (loaded.error) {
      throw new Error(`${initialErr.message}\nCDP Extensions.loadUnpacked failed: ${loaded.error}`);
    }
    foundWorker = await findExtensionWorker(browser.cdp, browser.stderr);
  }
  const extensionId = foundWorker.worker.url.match(/^chrome-extension:\/\/([^/]+)\//)[1];
  return { ...browser, extensionId, worker: foundWorker.worker, workerSession: foundWorker.sessionId };
}

async function refreshExtensionWorker(browser) {
  const foundWorker = await findExtensionWorker(browser.cdp, browser.stderr);
  browser.worker = foundWorker.worker;
  browser.workerSession = foundWorker.sessionId;
  browser.extensionId = foundWorker.worker.url.match(/^chrome-extension:\/\/([^/]+)\//)[1];
  return browser;
}

async function openExtensionPage(cdp, extensionId, pagePath) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/${pagePath}`
  });
  const sessionId = await attach(cdp, targetId);
  await waitFor(async () => evaluate(cdp, sessionId, 'document.readyState === "complete" || document.readyState === "interactive"'), `${pagePath} load`);
  return { targetId, sessionId };
}

async function createPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await waitFor(async () => evaluate(cdp, sessionId, 'document.readyState === "complete" || document.readyState === "interactive"'), `${url} load`);
  return { targetId, sessionId };
}

async function sendRuntimeMessage(cdp, sessionId, message) {
  return evaluate(cdp, sessionId, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
}

async function getTabs(cdp, workerSession) {
  return evaluate(cdp, workerSession, 'chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url, active: tab.active })))');
}

module.exports = {
  attach,
  createPage,
  evaluate,
  expectedRulesets,
  getTabs,
  getTargets,
  manifest,
  openExtensionPage,
  repoRoot,
  refreshExtensionWorker,
  sendRuntimeMessage,
  startExtensionBrowser,
  waitFor
};
