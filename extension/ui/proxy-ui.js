/**
 * Chroma Ad-Blocker - Proxy editor/status UI.
 * Shared by the compact popup summary and the full settings editor.
 */

'use strict';

const ChromaProxyUI = (() => {
  const { $, escapeHTML, isSettingsPage, openProxySettings } = globalThis.ChromaApp;
  const SMART_LINK_HOSTS = ['youtube.com', 'youtu.be', 'twitch.tv', 'netflix.com', 'amazon.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com', 'spotify.com'];

  function routeSummary(activeDomainCount, isGlobal, isEnabled = true) {
    if (!isEnabled) return 'routing paused';
    return isGlobal ? 'global fallback' : `${activeDomainCount} routed`;
  }

  function setHidden(element, hidden) {
    element?.classList.toggle('is-hidden', hidden);
  }

  function setStatusDotState(dot, state) {
    if (!dot) return;
    ['proxy-status-dot--online', 'proxy-status-dot--offline', 'proxy-status-dot--muted']
      .forEach(cls => dot.classList.remove(cls));
    dot.classList.add(`proxy-status-dot--${state}`);
  }

  function appendElement(parent, tagName, className = '', textContent = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (textContent !== '') element.textContent = textContent;
    parent.appendChild(element);
    return element;
  }

  function renderStatusLineHtml(statusText = 'Checking...', controlsHtml = '') {
    return `
      <div class="proxy-status-line">
        <span class="proxy-status-dot proxy-status-dot--muted"></span>
        <span class="proxy-status-text">${escapeHTML(statusText)}</span>
        ${controlsHtml}
      </div>
    `;
  }

  function globalProxyConfirmMessage() {
    return [
      'Global proxy mode can route all browser traffic through this proxy when no domain-specific route matches.',
      '',
      'Recommended: Chroma will also use WebRTC Leak Protection in Auto mode to prevent WebRTC from bypassing the proxy.',
      '',
      'Enable global proxy mode?'
    ].join('\n');
  }

  async function renderWebRtcControl(container) {
    const config = await notifyBackground({ type: MSG.CONFIG_GET }) || {};
    const row = document.createElement('div');
    row.className = 'protection-list proxy-webrtc-control';

    const info = appendElement(row, 'div', 'toggle-info');
    appendElement(info, 'div', 'name', 'WebRTC Leak Protection');
    appendElement(info, 'div', 'desc', 'Controls Chrome WebRTC IP handling for browser-level proxy fallback');

    const select = appendElement(row, 'select', 'chroma-input chroma-input--compact proxy-webrtc-select');
    for (const [value, label] of [
      ['off', 'Off'],
      ['auto', 'Auto (Recommended)'],
      ['balanced', 'Balanced'],
      ['strict', 'Strict']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = ['off', 'auto', 'balanced', 'strict'].includes(config.webRtcLeakProtection)
      ? config.webRtcLeakProtection
      : 'auto';
    select.addEventListener('change', async () => {
      await notifyBackground({
        type: MSG.CONFIG_SET,
        config: { webRtcLeakProtection: select.value }
      });
    });

    container.appendChild(row);
  }

  function renderPopupSummaryCardHtml(pc, index, { accepted, activeDomainCount, isGlobal, isEnabled }) {
    return `
      <div class="proxy-card-body">
        <div class="proxy-main">
          <div class="proxy-title">${escapeHTML(pc.name || 'Server ' + (index + 1))}</div>
          <div class="proxy-endpoint">${accepted ? `${escapeHTML(pc.host)}:${escapeHTML(pc.port)}` : 'Not configured'}</div>
          <div class="proxy-meta-text">${escapeHTML(pc.type || 'PROXY')} &middot; ${pc.hasCredentials ? 'credentials saved' : 'no credentials'} &middot; ${routeSummary(activeDomainCount, isGlobal, isEnabled)}</div>
          ${renderStatusLineHtml(accepted ? 'Checking...' : 'Open settings to configure')}
        </div>
        <div class="proxy-actions">
          ${accepted ? `
            <button class="reset-btn proxy-refresh-btn compact-action-btn" title="Refresh Connection">&#x21bb;</button>
            <button class="reset-btn proxy-global-btn compact-action-btn" title="Use as Global Fallback">GLOBAL</button>
            <label class="switch switch-sm" title="Enable Proxy Routing">
              <input type="checkbox" class="proxy-enabled-toggle" />
              <span class="slider"></span>
            </label>
          ` : ''}
        </div>
      </div>
    `;
  }

  function renderEditorCardHtml(pc, index, inputGroupId, activeGroupId) {
    const isAccepted = pc.accepted && pc.host && pc.port;
    return `
      <div id="${inputGroupId}" class="proxy-grid proxy-input-group ${isAccepted ? 'is-hidden' : ''}">
        <select class="chroma-input proxy-type proxy-grid-wide proxy-type-select">
          <option value="PROXY" ${(pc.type === 'PROXY' || !pc.type) ? 'selected' : ''}>HTTP (Default)</option>
          <option value="HTTPS" ${pc.type === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
          <option value="SOCKS4" ${pc.type === 'SOCKS4' ? 'selected' : ''}>SOCKS4</option>
          <option value="SOCKS5" ${pc.type === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
        </select>
        <input type="text" class="chroma-input proxy-name proxy-grid-wide" value="${escapeHTML(pc.name || '')}" placeholder="Display name (optional)" />
        <input type="text" class="chroma-input proxy-host" value="${escapeHTML(pc.host)}" placeholder="Proxy Host (e.g. 1.2.3.4)" />
        <input type="text" class="chroma-input proxy-port" value="${escapeHTML(pc.port)}" placeholder="Port (e.g. 80)" />
        <input type="text" class="chroma-input proxy-user" value="" placeholder="Username" />
        <input type="password" class="chroma-input proxy-pass" value="" placeholder="${pc.hasCredentials ? 'Password saved' : 'Password'}" />
        <div class="proxy-credential-row">
          <span class="proxy-credential-help">${pc.hasCredentials ? 'Credentials saved locally. Leave fields blank to keep them.' : 'Credentials are locally obfuscated in extension storage and used only for proxy authentication.'}</span>
          <button class="reset-btn proxy-clear-credentials-btn inline-danger-btn ${pc.hasCredentials ? '' : 'is-hidden'}">Clear credentials</button>
        </div>
        <div class="proxy-auth-note proxy-grid-wide is-hidden">SOCKS auth isn't supported by Chrome - use IP whitelisting on your provider.</div>
        <div class="proxy-error proxy-grid-wide is-hidden"></div>
        <div class="proxy-form-actions">
          <button class="reset-btn proxy-accept-btn form-submit-btn">Accept Settings</button>
          <button class="reset-btn proxy-del-server-btn inline-danger-btn compact-action-btn" title="Delete Server">Delete</button>
        </div>
      </div>

      <div id="${activeGroupId}" class="proxy-active-group ${isAccepted ? '' : 'is-hidden'}">
        <div class="proxy-main">
          <div class="proxy-title">Active: ${escapeHTML(pc.name || 'Server ' + (index + 1))}</div>
          <div class="proxy-endpoint">${escapeHTML(pc.host)}:${escapeHTML(pc.port)}</div>
          ${renderStatusLineHtml('Checking...', `
            <button class="reset-btn proxy-edit-btn compact-action-btn" title="Edit Server">Edit</button>
            <button class="reset-btn proxy-refresh-btn compact-action-btn" title="Refresh Connection">&#x21bb;</button>
            <button class="reset-btn proxy-global-btn compact-action-btn" title="Use as Global Fallback">GLOBAL</button>
            <button class="reset-btn proxy-clear-settings-btn inline-danger-btn compact-action-btn" title="Clear Settings">Clear</button>
          `)}
        </div>
        <div class="proxy-enabled-control">
          <label class="switch switch-sm" title="Enable Proxy Routing">
            <input type="checkbox" class="proxy-enabled-toggle" />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="proxy-grid-full proxy-domain-tools">
        <input type="text" class="chroma-input chroma-input--compact proxy-domain-input" placeholder="Domain (e.g. youtube.com)" />
        <button class="reset-btn proxy-add-domain-btn compact-action-btn">ADD</button>
      </div>
      <div class="proxy-domain-list">
        <!-- Domains will be injected here -->
      </div>
    `;
  }

  function isSmartLinkedDomain(host) {
    return SMART_LINK_HOSTS.some(smartHost => host === smartHost || host.endsWith('.' + smartHost));
  }

  function renderDomainRow(domain, { onToggle, onRemove }) {
    const row = document.createElement('div');
    row.className = 'toggle-row proxy-domain-row';

    const info = appendElement(row, 'div', 'toggle-info');
    const name = appendElement(info, 'div', 'name proxy-domain-name', domain.host);
    if (isSmartLinkedDomain(domain.host)) {
      const badge = appendElement(name, 'span', 'badge purple smart-link-badge', 'Smart-Link');
      badge.title = 'Automatically routed proxy domain';
    }

    const actions = appendElement(row, 'div', 'proxy-domain-actions');
    const removeBtn = appendElement(actions, 'button', 'reset-btn d-del-btn inline-danger-btn compact-action-btn', 'Remove');
    removeBtn.title = 'Remove Domain';
    appendElement(actions, 'span', 'inline-separator');

    const toggleLabel = appendElement(actions, 'label', 'switch switch-sm');
    const toggleInput = appendElement(toggleLabel, 'input', 'd-toggle');
    toggleInput.type = 'checkbox';
    toggleInput.checked = !!domain.enabled;
    appendElement(toggleLabel, 'span', 'slider');

    toggleInput.addEventListener('change', onToggle);
    removeBtn.addEventListener('click', onRemove);
    return row;
  }

  function setOnlineStatus({ txt, dot, meta, pc, activeDomainCount, isGlobal, isEnabled = true, ip = '' }) {
    if (!txt || !dot) return;
    const ipSuffix = ip ? ` (${ip})` : '';
    const type = pc.type || 'PROXY';
    const credentials = pc.hasCredentials ? 'credentials saved' : 'no credentials';

    if (!isEnabled) {
      txt.textContent = 'DISABLED';
      if (meta) meta.textContent = `${type} - ${credentials} - routing paused`;
      setStatusDotState(dot, 'muted');
    } else if (isGlobal) {
      txt.textContent = `GLOBAL PROXY ACTIVE${ipSuffix}`;
      if (meta) meta.textContent = `${type} - ${credentials} - global fallback`;
    } else if (activeDomainCount > 0) {
      txt.textContent = `ROUTING ${activeDomainCount} DOMAIN${activeDomainCount > 1 ? 'S' : ''}${ipSuffix}`;
      if (meta) meta.textContent = `${type} - ${credentials} - ${activeDomainCount} routed`;
    } else {
      txt.textContent = `CONNECTED${ipSuffix}`;
      if (meta) meta.textContent = `${type} - ${credentials} - 0 routed`;
    }
    setStatusDotState(dot, 'online');
  }

  function renderPopupProxyCard(pc, index, proxyConfigState, { saveAllConfigs }) {
    const accepted = !!(pc.accepted && pc.host && pc.port);
    const isEnabled = pc.enabled !== false;
    const activeDomainCount = (pc.domains || []).filter(d => d.enabled).length;
    const isGlobal = !!(accepted && proxyConfigState.globalProxyEnabled && proxyConfigState.globalProxyId === pc.id);
    const card = document.createElement('div');
    card.className = 'protection-list proxy-card';
    card.innerHTML = renderPopupSummaryCardHtml(pc, index, { accepted, activeDomainCount, isGlobal, isEnabled });

    const txt = card.querySelector('.proxy-status-text');
    const dot = card.querySelector('.proxy-status-dot');
    const meta = card.querySelector('.proxy-meta-text');
    const refreshBtn = card.querySelector('.proxy-refresh-btn');
    const globalBtn = card.querySelector('.proxy-global-btn');
    const enabledToggle = card.querySelector('.proxy-enabled-toggle');

    const getStatusContext = (ip = '') => ({
      txt,
      dot,
      meta,
      pc,
      activeDomainCount,
      isGlobal: globalBtn?.classList.contains('is-active') === true,
      isEnabled: enabledToggle?.checked !== false,
      ip
    });

    if (globalBtn) {
      globalBtn.classList.toggle('is-active', isGlobal);
      globalBtn.addEventListener('click', async () => {
        if (globalBtn.classList.contains('is-active')) {
          const result = await notifyBackground({
            type: MSG.CONFIG_SET,
            config: { globalProxyEnabled: false, globalProxyId: null }
          });
          if (!result || result.ok === false) {
            setOnlineStatus(getStatusContext());
            return;
          }
          globalBtn.classList.remove('is-active');
          await loadProxyRouterUI();
          return;
        }

        if (typeof confirm === 'function' && !confirm(globalProxyConfirmMessage())) {
          return;
        }
        pc.enabled = true;
        if (enabledToggle) enabledToggle.checked = true;
        const saveResult = await saveAllConfigs();
        if (!saveResult || saveResult.ok === false) {
          pc.enabled = isEnabled;
          if (enabledToggle) enabledToggle.checked = isEnabled;
          setOnlineStatus(getStatusContext());
          return;
        }
        const result = await notifyBackground({
          type: MSG.CONFIG_SET,
          config: {
            globalProxyEnabled: true,
            globalProxyId: pc.id
          }
        });
        if (!result || result.ok === false) {
          globalBtn.classList.toggle('is-active', isGlobal);
          setOnlineStatus(getStatusContext());
          return;
        }
        await loadProxyRouterUI();
      });
    }

    if (enabledToggle) {
      enabledToggle.checked = isEnabled;
      enabledToggle.addEventListener('change', async (e) => {
        const wasEnabled = pc.enabled !== false;
        const nextEnabled = e.target.checked;
        pc.enabled = nextEnabled;
        const result = await saveAllConfigs();
        if (!result || result.ok === false) {
          pc.enabled = wasEnabled;
          e.target.checked = wasEnabled;
        }
        await loadProxyRouterUI();
      });
    }

    const testConnection = async () => {
      if (!accepted || !txt || !dot) return;
      setStatusDotState(dot, 'muted');
      txt.textContent = 'Verifying...';
      const res = await notifyBackground({ type: MSG.PROXY_TEST, proxyId: pc.id });
      if (res && res.ok) {
        setOnlineStatus(getStatusContext(res.ip));
      } else {
        setStatusDotState(dot, 'offline');
        txt.textContent = res ? `Offline (${res.error})` : 'Offline';
      }
    };

    refreshBtn?.addEventListener('click', testConnection);
    if (accepted && isEnabled) {
      testConnection();
    } else if (accepted) {
      setOnlineStatus(getStatusContext());
    }
    return card;
  }

  async function renderPopupSummary(container, addBtn, proxyConfigs) {
    const { config: proxyConfigState = {} } = await chrome.storage.local.get('config');
    const { saveAllConfigs } = createProxyStore(proxyConfigs);
    if (addBtn) {
      addBtn.title = 'Manage Proxies';
      addBtn.onclick = openProxySettings;
    }

    container.innerHTML = '';
    if (proxyConfigs.length === 0) {
      container.innerHTML = '<div class="protection-list proxy-empty">No proxy servers configured.</div>';
    } else {
      proxyConfigs.forEach((pc, i) => container.appendChild(renderPopupProxyCard(pc, i, proxyConfigState, { saveAllConfigs })));
    }

    const manage = document.createElement('button');
    manage.className = 'reset-btn proxy-manage-btn';
    manage.textContent = 'Manage proxies';
    manage.addEventListener('click', openProxySettings);
    container.appendChild(manage);
  }

  function createProxyStore(proxyConfigs) {
    const buildProxySavePayload = (credentialById = new Map()) => proxyConfigs
      .filter(pc => pc.accepted === true)
      .map(pc => {
        const credential = credentialById.get(pc.id) || {};
        const action = credential.action || pc.credentialAction || 'preserve';
        const out = {
          id: pc.id,
          name: pc.name,
          host: pc.host,
          port: pc.port,
          type: pc.type,
          accepted: pc.accepted,
          enabled: pc.enabled !== false,
          domains: pc.domains,
          credentialAction: action
        };
        if (out.credentialAction === 'replace') {
          out.username = credential.username || '';
          out.password = credential.password || '';
        }
        return out;
      });

    const saveAllConfigs = (credentialById = new Map()) => {
      return notifyBackground({ type: MSG.PROXY_CONFIG_SET, proxyConfigs: buildProxySavePayload(credentialById) });
    };

    return { saveAllConfigs };
  }

  async function renderSettingsEditor(container, addBtn, proxyConfigs) {
    const { saveAllConfigs } = createProxyStore(proxyConfigs);

    const renderProxyCard = (pc, index) => {
      const card = document.createElement('div');
      card.className = 'protection-list proxy-card';
      card.dataset.index = index;

      const inputGroupId = `proxyInputGroup_${index}`;
      const activeGroupId = `proxyActiveGroup_${index}`;

      card.innerHTML = renderEditorCardHtml(pc, index, inputGroupId, activeGroupId);

      const typeSelect = card.querySelector('.proxy-type');
      const nameInput = card.querySelector('.proxy-name');
      const hostInput = card.querySelector('.proxy-host');
      const portInput = card.querySelector('.proxy-port');
      const userInput = card.querySelector('.proxy-user');
      const passInput = card.querySelector('.proxy-pass');
      const authNote = card.querySelector('.proxy-auth-note');
      const clearCredentialsBtn = card.querySelector('.proxy-clear-credentials-btn');
      const errorEl = card.querySelector('.proxy-error');

      const replaceThisCard = () => {
        card.replaceWith(renderProxyCard(pc, proxyConfigs.indexOf(pc)));
      };

      let pendingCredentialAction = pc.credentialAction || 'preserve';
      let displayedHasCredentials = !!pc.hasCredentials;

      const resetCredentialStateAfterSave = () => {
        pc.credentialAction = 'preserve';
        pendingCredentialAction = 'preserve';
      };

      const showProxyError = (message) => {
        if (!errorEl) return;
        errorEl.textContent = message;
        setHidden(errorEl, !message);
      };

      const clearCredentialInputs = () => {
        userInput.value = '';
        passInput.value = '';
      };

      const updateCredentialHelp = () => {
        const help = card.querySelector('.proxy-credential-help');
        if (help) {
          help.textContent = displayedHasCredentials
            ? 'Credentials saved locally. Leave fields blank to keep them.'
            : 'Credentials are locally obfuscated in extension storage and used only for proxy authentication.';
        }
        if (passInput) passInput.placeholder = displayedHasCredentials ? 'Password saved' : 'Password';
        setHidden(clearCredentialsBtn, !displayedHasCredentials);
      };

      const readCredentialAction = () => {
        const username = userInput.value.trim();
        const password = passInput.value;
        const isSocks = typeSelect.value === 'SOCKS4' || typeSelect.value === 'SOCKS5';
        if (isSocks) return { ok: true, credential: { action: pendingCredentialAction === 'clear' ? 'clear' : 'preserve' } };
        if (username && password) return { ok: true, credential: { action: 'replace', username, password } };
        if (!username && !password) return { ok: true, credential: { action: pendingCredentialAction === 'clear' ? 'clear' : 'preserve' } };
        return { ok: false, error: 'Enter both username and password, or leave both blank to keep saved credentials.' };
      };

      // Chrome's webRequest.onAuthRequired only fires for HTTP(S) 407 challenges,
      // so SOCKS4/5 username+password auth can never succeed - hide the fields.
      let previousType = typeSelect.value;
      const applyAuthVisibility = (fromUserChange = false) => {
        const isSocks = typeSelect.value === 'SOCKS4' || typeSelect.value === 'SOCKS5';
        userInput.disabled = isSocks;
        passInput.disabled = isSocks;
        setHidden(userInput, isSocks);
        setHidden(passInput, isSocks);
        if (authNote) {
          authNote.textContent = 'SOCKS username/password auth is not supported by Chrome here. Use provider-side IP allowlisting or an HTTP/HTTPS proxy.';
          setHidden(authNote, !isSocks);
        }
        if (isSocks && fromUserChange && (displayedHasCredentials || userInput.value || passInput.value)) {
          if (typeof confirm === 'function' && !confirm('SOCKS username/password auth is not supported by Chrome here. Clear saved credentials for this proxy?')) {
            typeSelect.value = previousType;
            return applyAuthVisibility(false);
          }
          clearCredentialInputs();
          pendingCredentialAction = 'clear';
          displayedHasCredentials = false;
          updateCredentialHelp();
        }
        previousType = typeSelect.value;
      };
      applyAuthVisibility();
      typeSelect.addEventListener('change', () => applyAuthVisibility(true));
      const domainInput = card.querySelector('.proxy-domain-input');
      const addDomainBtn = card.querySelector('.proxy-add-domain-btn');
      const domainList = card.querySelector('.proxy-domain-list');
      const acceptBtn = card.querySelector('.proxy-accept-btn');
      const clearBtn = card.querySelector('.proxy-clear-settings-btn');
      const delServerBtn = card.querySelector('.proxy-del-server-btn');
      const editBtn = card.querySelector('.proxy-edit-btn');
      const refreshBtn = card.querySelector('.proxy-refresh-btn');
      const globalBtn = card.querySelector('.proxy-global-btn');
      const enabledToggle = card.querySelector('.proxy-enabled-toggle');

      clearCredentialsBtn?.addEventListener('click', async () => {
        clearCredentialInputs();
        pc.credentialAction = 'clear';
        pc.hasCredentials = false;
        pendingCredentialAction = 'clear';
        displayedHasCredentials = false;
        updateCredentialHelp();
        await saveAllConfigs(new Map([[pc.id, { action: 'clear' }]]));
        resetCredentialStateAfterSave();
        replaceThisCard();
      });

      const updateGlobalUI = async () => {
        if (!globalBtn) return;
        const { config: c } = await chrome.storage.local.get('config');
        const isGlobal = !!(c?.globalProxyEnabled && c?.globalProxyId === pc.id);
        globalBtn.classList.toggle('is-active', isGlobal);
        setGlobalDomainVisibility(isGlobal);
        updateStatusLine();
      };

      const updateEnabledUI = () => {
        if (enabledToggle) enabledToggle.checked = pc.enabled !== false;
      };

      const setGlobalDomainVisibility = (isGlobal) => {
        setHidden(card.querySelector('.proxy-domain-tools'), isGlobal);
        setHidden(card.querySelector('.proxy-domain-list'), isGlobal);
      };

      const updateStatusLine = (ip = null) => {
        const txt = card.querySelector('.proxy-status-text');
        const dot = card.querySelector('.proxy-status-dot');
        if (!txt || !dot) return;

        const isEnabled = pc.enabled !== false;
        if (!isEnabled) {
          txt.textContent = 'DISABLED';
          setStatusDotState(dot, 'muted');
          return;
        }

        // If we're verifying and don't have an IP yet, don't overwrite the 'Verifying...' state
        if (!ip && (txt.textContent === 'Checking...' || txt.textContent === 'Verifying...')) return;
        
        // If we're offline, don't overwrite unless we have a new IP
        if (!ip && txt.textContent.startsWith('Offline')) return;

        const isGlobal = globalBtn?.classList.contains('is-active') === true;
        const activeDomainCount = (pc.domains || []).filter(d => d.enabled).length;

        const currentIp = ip || txt.textContent.match(/\((.*?)\)/)?.[1] || '';
        const ipSuffix = currentIp ? ` (${currentIp})` : '';

        if (isGlobal) {
          txt.textContent = `GLOBAL PROXY ACTIVE${ipSuffix}`;
          setStatusDotState(dot, 'online');
        } else if (activeDomainCount > 0) {
          txt.textContent = `ROUTING ${activeDomainCount} DOMAIN${activeDomainCount > 1 ? 'S' : ''}${ipSuffix}`;
          setStatusDotState(dot, 'online');
        } else {
          txt.textContent = `CONNECTED${ipSuffix}`;
          setStatusDotState(dot, 'online');
        }
      };

      const testConnection = async () => {
        const dot = card.querySelector('.proxy-status-dot');
        const txt = card.querySelector('.proxy-status-text');
        if (!dot || !txt) return;
        if (pc.enabled === false) {
          updateStatusLine();
          return;
        }

        setStatusDotState(dot, 'muted');
        txt.textContent = 'Verifying...';

        const res = await notifyBackground({ type: MSG.PROXY_TEST, proxyId: pc.id });
        if (res && res.ok) {
          updateStatusLine(res.ip);
        } else {
          setStatusDotState(dot, 'offline');
          txt.textContent = res ? `Offline (${res.error})` : 'Offline';
        }
      };

      const renderDomains = () => {
        domainList.innerHTML = '';
        if (!pc.domains || pc.domains.length === 0) {
          domainList.innerHTML = '<div class="toggle-row loading-row"><span class="loading-text">No domains.</span></div>';
          return;
        }

        pc.domains.forEach((d, dIdx) => {
          const dRow = renderDomainRow(d, {
            onToggle: async (e) => {
              pc.domains[dIdx].enabled = e.target.checked;
              await saveAllConfigs();
              updateStatusLine();
            },
            onRemove: async () => {
              pc.domains.splice(dIdx, 1);
              await saveAllConfigs();
              renderDomains();
              updateStatusLine();
            }
          });

          domainList.appendChild(dRow);
        });
      };

      renderDomains();
      updateEnabledUI();

      if (pc.accepted && pc.host && pc.port) {
        if (pc.enabled !== false) testConnection();
        updateGlobalUI();
      }

      globalBtn?.addEventListener('click', async () => {
        if (globalBtn.classList.contains('is-active')) {
          const result = await notifyBackground({
            type: MSG.CONFIG_SET,
            config: { globalProxyEnabled: false, globalProxyId: null }
          });
          if (!result || result.ok === false) {
            updateStatusLine();
            return;
          }
          globalBtn.classList.remove('is-active');
          setGlobalDomainVisibility(false);
          updateStatusLine();
          return;
        }

        if (typeof confirm === 'function' && !confirm(globalProxyConfirmMessage())) {
          return;
        }
        const wasEnabled = pc.enabled !== false;
        pc.enabled = true;
        updateEnabledUI();
        const saveResult = await saveAllConfigs();
        if (!saveResult || saveResult.ok === false) {
          pc.enabled = wasEnabled;
          updateEnabledUI();
          updateStatusLine();
          return;
        }
        const result = await notifyBackground({
          type: MSG.CONFIG_SET, 
          config: { 
            globalProxyEnabled: true,
            globalProxyId: pc.id
          } 
        });
        if (!result || result.ok === false) {
          updateStatusLine();
          return;
        }
        document.querySelectorAll('.proxy-global-btn').forEach(btn => {
          btn.classList.toggle('is-active', btn === globalBtn);
          const otherCard = btn.closest('.proxy-card');
          setHidden(otherCard?.querySelector('.proxy-domain-tools'), btn === globalBtn);
          setHidden(otherCard?.querySelector('.proxy-domain-list'), btn === globalBtn);
        });
        updateStatusLine();
      });

      enabledToggle?.addEventListener('change', async (e) => {
        const wasEnabled = pc.enabled !== false;
        const nextEnabled = e.target.checked;
        pc.enabled = nextEnabled;
        const result = await saveAllConfigs();
        if (!result || result.ok === false) {
          pc.enabled = wasEnabled;
          e.target.checked = wasEnabled;
        }
        updateStatusLine();
      });

      acceptBtn.addEventListener('click', async () => {
        showProxyError('');
        const host = hostInput.value.trim().replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '').replace(/\/.*$/, '');
        pc.name = nameInput.value.trim();
        pc.type = typeSelect.value;
        pc.host = host;
        pc.port = portInput.value.trim();
        pc.enabled = pc.enabled !== false;
        const credentialResult = readCredentialAction();
        if (!credentialResult.ok) {
          showProxyError(credentialResult.error);
          return;
        }
        pc.accepted = true;
        
        const result = await saveAllConfigs(new Map([[pc.id, credentialResult.credential]])); // Force immediate save and wait for background to sync
        if (!result || result.ok === false || result.errors?.length) {
          showProxyError(result?.error || result?.errors?.[0] || 'Unable to save proxy settings.');
          return;
        }
        if (credentialResult.credential.action === 'replace') pc.hasCredentials = true;
        if (credentialResult.credential.action === 'clear') pc.hasCredentials = false;
        clearCredentialInputs();
        resetCredentialStateAfterSave();

        replaceThisCard();
      });

      clearBtn.addEventListener('click', async () => {
        pc.accepted = false;
        await saveAllConfigs();
        replaceThisCard();
      });

      editBtn?.addEventListener('click', () => {
        const inputGroup = document.getElementById(inputGroupId);
        const activeGroup = document.getElementById(activeGroupId);
        setHidden(inputGroup, false);
        setHidden(activeGroup, true);
        hostInput.focus?.();
      });

      delServerBtn.addEventListener('click', async () => {
        const idx = proxyConfigs.findIndex(p => p.id === pc.id);
        if (idx > -1) proxyConfigs.splice(idx, 1);
        await saveAllConfigs();
        if (proxyConfigs.length === 0) {
          await renderAll();
        } else {
          card.remove();
        }
      });

      refreshBtn?.addEventListener('click', testConnection);

      addDomainBtn.addEventListener('click', async () => {
        let d = domainInput.value.trim().toLowerCase();
        d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (d) {
          if (!pc.domains) pc.domains = [];
          if (!pc.domains.find(x => x.host === d)) {
            pc.domains.push({ host: d, enabled: true });
            domainInput.value = '';
            if (pc.accepted) await saveAllConfigs();
            renderDomains();
          }
        }
      });

      domainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addDomainBtn.click();
      });

      return card;
    };

    const renderAll = async () => {
      container.innerHTML = '';
      await renderWebRtcControl(container);
      if (proxyConfigs.length === 0) {
        appendElement(container, 'div', 'protection-list proxy-empty', 'No proxy servers configured. Click + to add one.');
      } else {
        proxyConfigs.forEach((pc, i) => {
          container.appendChild(renderProxyCard(pc, i));
        });
      }
    };

    addBtn.onclick = async () => {
      const newPc = {
        id: Date.now(),
        type: 'PROXY',
        host: '',
        port: '',
        accepted: false,
        domains: [],
        enabled: true,
        hasCredentials: false,
        credentialAction: 'preserve'
      };
      proxyConfigs.push(newPc);
      container.querySelector('.proxy-empty')?.remove();
      container.appendChild(renderProxyCard(newPc, proxyConfigs.length - 1));
      container.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    };

    await renderAll();
  }

  async function loadProxyRouterUI() {
    const container = $('proxyRouterContainer');
    const addBtn = $('addProxyServerBtn');
    if (!container) return;

    const settingsMode = isSettingsPage();
    if (settingsMode && !addBtn) return;
    let proxyConfigs = await notifyBackground({ type: MSG.PROXY_CONFIG_GET }) || [];
    proxyConfigs.forEach(pc => {
      pc.credentialAction = 'preserve';
      delete pc.username;
      delete pc.password;
      delete pc.authIv;
      delete pc.authCipher;
    });

    if (!settingsMode) {
      await renderPopupSummary(container, addBtn, proxyConfigs);
      return;
    }

    await renderSettingsEditor(container, addBtn, proxyConfigs);
  }

  return { loadProxyRouterUI };
})();

globalThis.ChromaProxyUI = ChromaProxyUI;
