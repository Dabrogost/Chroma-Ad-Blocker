/**
 * Chroma Ad-Blocker - Static UI shell components.
 * Keeps popup/settings markup shared without adding a build step.
 */

'use strict';

const ChromaComponents = (() => {
  const githubIcon = `
    <svg viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
  `;

  const settingsIcon = `
    <svg id="settingsIcon" class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Open Settings">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  `;

  const plusIcon = `
    <svg class="icon-action-btn__icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `;

  function renderHeader() {
    return `
      <header>
        <div class="pill-nav-inner">
          <img src="../icons/icon48.png" class="logo" alt="Logo" />
          <div class="title-group">
            <h1>Chroma Ad-Blocker</h1>
            <span>Ad-Blocker & Annoyance Eliminator</span>
          </div>
          <div class="status-group">
            <label class="switch header-switch">
              <input type="checkbox" id="toggleEnabled" checked />
              <span class="slider"></span>
            </label>
            <div class="status-dot" id="statusDot"></div>
          </div>
        </div>
      </header>
    `;
  }

  function renderStats({ showSettingsIcon }) {
    return `
      <div class="stats-container">
        <div class="stat-card" id="cardNetwork">
          <div class="stat-value" id="statProtectionEvents">0</div>
          <div class="stat-label">Protection Events</div>
          <div class="stat-breakdown" id="statHeroBreakdown">
            <span>Network <strong id="statBreakdownNetwork">0</strong></span>
            <span>Cleanup <strong id="statBreakdownCleanup">0</strong></span>
            <span>Scriptlets <strong id="statBreakdownScriptlets">0</strong></span>
            <span>Proxy <strong id="statBreakdownProxy">0</strong></span>
          </div>
          ${showSettingsIcon ? settingsIcon : ''}
        </div>
      </div>
    `;
  }

  function renderToggleRow({ inputId, rowId = '', rowClass = '', name, desc, badge = '' }) {
    return `
      <div class="toggle-row${rowClass ? ` ${rowClass}` : ''}"${rowId ? ` id="${rowId}"` : ''}>
        <div class="toggle-info">
          <div class="name">${name}${badge}</div>
          <div class="desc">${desc}</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="${inputId}" />
          <span class="slider"></span>
        </label>
      </div>
    `;
  }

  function renderProtectionControls({ showZapper }) {
    const zapperRow = showZapper ? `
      <div class="toggle-row zapper-action-row">
        <div class="toggle-info">
          <div class="name">Element Zapper</div>
          <div class="desc" id="zapperStatus">Pick one page element to hide</div>
        </div>
        <button class="reset-btn" id="zapElementBtn">Zap Element</button>
      </div>
    ` : '';

    return `
      <div class="section-title">Protection Layers</div>
      <div class="protection-list">
        ${zapperRow}
        ${renderToggleRow({
          inputId: 'toggleNetwork',
          name: 'Network Blocking',
          badge: ' <span class="badge" title="Core filtering engine">Primary</span>',
          desc: 'Blocks known ad and tracker requests'
        })}
        ${renderToggleRow({
          inputId: 'toggleStripping',
          name: 'YouTube Ad Block',
          desc: 'Strips ads from YouTube API before playback'
        })}
        ${renderToggleRow({
          inputId: 'toggleAcceleration',
          name: 'Ad Acceleration',
          desc: 'Mute + accelerate ads; changes anti-detection network behavior'
        })}
        <div class="toggle-row speed-selector-row" id="speedSelectorRow">
          <div class="toggle-info">
            <div class="name speed-selector-title">Acceleration Speed</div>
          </div>
          <div id="speedButtons" class="speed-buttons">
            <button class="speed-btn" data-speed="4">&times;4</button>
            <button class="speed-btn" data-speed="8">&times;8</button>
            <button class="speed-btn" data-speed="12">&times;12</button>
            <button class="speed-btn" data-speed="16">&times;16</button>
          </div>
        </div>
        ${renderToggleRow({
          inputId: 'toggleCosmetic',
          name: 'Cosmetic Filtering',
          desc: 'Hides banners, sponsored slots, overlays'
        })}
        ${renderToggleRow({
          inputId: 'toggleShorts',
          name: 'Hide YT Shorts',
          desc: 'Hides Shorts shelves and sidebar tabs'
        })}
        ${renderToggleRow({
          inputId: 'toggleMerch',
          name: 'Hide YT Merch',
          desc: 'Removes creator product carousels'
        })}
        ${renderToggleRow({
          inputId: 'toggleOffers',
          name: 'Hide Watch on YT',
          desc: 'Removes movie/TV purchase offers'
        })}
        ${renderToggleRow({
          inputId: 'toggleWarnings',
          name: 'Warning Suppression',
          desc: 'Removes "ad blocker detected" dialogs'
        })}
        ${renderToggleRow({
          inputId: 'toggleFingerprintRandomization',
          name: 'Fingerprint Randomization',
          badge: ' <span class="badge purple" title="Experimental &mdash; opt-in">Beta</span>',
          desc: 'Per-site noise to break cross-site tracking (does not lower uniqueness scores)'
        })}
        ${renderToggleRow({
          inputId: 'toggleFprWhitelist',
          rowId: 'rowFprWhitelist',
          rowClass: 'fpr-whitelist-row',
          name: 'Disable FPR on this site',
          desc: 'For sites broken by canvas/audio noise (bot checks, captchas)'
        })}
        ${renderToggleRow({
          inputId: 'toggleWhitelist',
          name: 'Whitelist this site',
          desc: 'Disable blocking on current domain'
        })}
      </div>
    `;
  }

  function renderFilterListShell() {
    return `
      <div class="section-title section-title--inline">
        <span class="section-title-text">Filter Lists</span>
        <button id="addSubscriptionBtn" class="reset-btn icon-action-btn" title="Add Filter List">
          ${plusIcon}
        </button>
      </div>
      <div id="addSubscriptionForm" class="protection-list add-subscription-form">
        <div class="add-subscription-grid">
          <input type="text" id="newSubName" class="chroma-input chroma-input--compact" placeholder="Name (optional)" />
          <input type="text" id="newSubUrl" class="chroma-input chroma-input--compact" placeholder="https://example.com/list.txt" />
          <div id="newSubError" class="form-error"></div>
          <div class="form-actions">
            <button id="newSubAddBtn" class="reset-btn form-submit-btn">Add</button>
            <button id="newSubCancelBtn" class="reset-btn inline-danger-btn" title="Cancel">&times;</button>
          </div>
        </div>
      </div>
      <div class="protection-list" id="subscriptionList">
        <div class="toggle-row loading-row">
          <span class="loading-text">Loading subscriptions...</span>
        </div>
      </div>
    `;
  }

  function renderHealthPanelShell() {
    return `
      <div class="section-title section-title--spaced">Health</div>
      <div class="protection-list health-panel" id="healthPanel">
        <div class="health-header">
          <div class="toggle-info">
            <div class="name">Overall: <span id="healthOverallLabel" class="health-status health-status--disabled">Loading</span></div>
            <div class="desc" id="healthVersionText">Checking protection layers...</div>
          </div>
          <button class="reset-btn compact-action-btn" id="refreshHealthBtn">Refresh Health</button>
        </div>
        <div class="health-grid" id="healthPanelBody">
          <div class="health-empty">Loading health diagnostics...</div>
        </div>
      </div>
    `;
  }

  function renderStatisticsShell() {
    return `
      <div class="section-title section-title--spaced">Protection Intelligence</div>
      <div class="protection-list stats-panel" id="statisticsPanel">
        <div class="stats-panel-header">
          <div class="toggle-info">
            <div class="name">Local Analytics</div>
            <div class="desc">All statistics are stored locally. Full request URLs are only kept when Debug Mode is enabled.</div>
          </div>
        </div>

        <div class="stats-card-grid" id="statisticsTopCards"></div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Overview</div>
          <div class="stats-range-grid" id="statsRangeSummary"></div>
        </div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Sites</div>
          <div class="stats-list" id="statsSitesList"></div>
        </div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Rules</div>
          <div class="stats-list" id="statsRulesList"></div>
        </div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Timeline</div>
          <div class="stats-timeline" id="statsTimelineList"></div>
        </div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Events</div>
          <div class="stats-list" id="statsEventsList"></div>
        </div>

        <div class="stats-subsection stats-privacy">
          <div class="stats-subsection-title">Privacy</div>
          <div class="stats-controls-grid">
            <select id="statsModeSelect" class="chroma-input chroma-input--compact">
              <option value="basic">Basic: totals only</option>
              <option value="aggregated">Aggregated: domains and rule sources</option>
              <option value="debug">Debug: include recent full URLs</option>
            </select>
            <select id="statsRetentionSelect" class="chroma-input chroma-input--compact">
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">365 days</option>
            </select>
          </div>
          <div class="stats-actions">
            <button class="reset-btn compact-action-btn" id="resetAllStats">Reset all stats</button>
            <button class="reset-btn compact-action-btn" id="resetSiteStats">Reset site stats</button>
            <button class="reset-btn compact-action-btn" id="resetRequestLogOnly">Reset debug request log</button>
            <button class="reset-btn compact-action-btn" id="exportStatsJson">Export JSON</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderProxyShell({ settingsMode }) {
    return `
      <div class="section-title section-title--inline"${settingsMode ? ' id="proxySection"' : ''}>
        <span class="section-title-text">Media Proxy Router</span>
        ${settingsMode ? `
          <button id="addProxyServerBtn" class="reset-btn icon-action-btn" title="Add Proxy Server">
            ${plusIcon}
          </button>
        ` : ''}
      </div>
      <div id="proxyRouterContainer">
        <!-- Proxy entries will be injected here -->
      </div>
    `;
  }

  function renderLocalZapperShell() {
    return `
      <div class="section-title section-title--spaced">Local Zapper Rules</div>
      <div class="protection-list" id="localZapperRules">
        <div class="toggle-row loading-row">
          <span class="loading-text">Loading local rules...</span>
        </div>
      </div>
    `;
  }

  function renderRequestLogShell() {
    return `
      <div class="section-title section-title--spaced">Request Log</div>
      <div class="protection-list" id="requestLogPanel">
        <div class="log-header" id="logToggleRow">
          <div class="toggle-info">
            <div class="name">Matched Requests</div>
            <div class="desc">Rules fired on this session</div>
          </div>
          <button class="log-toggle-btn" id="logToggleBtn" title="Expand log">&#x25bc;</button>
        </div>
        <div class="log-entries" id="logEntries">
          <div class="log-empty">No entries yet.</div>
        </div>
      </div>
    `;
  }

  function renderFooter() {
    return `
      <footer>
        <button class="reset-btn" id="resetStats">Reset Stats</button>
        <div class="footer-right">
          <a href="https://github.com/Dabrogost/Chroma-Ad-Blocker" target="_blank" class="github-link" title="View Source on GitHub">
            ${githubIcon}
          </a>
          <span class="version" id="versionText">v1.0.0 &middot; MV3</span>
        </div>
      </footer>
    `;
  }

  function renderPageShell({ settingsMode = false } = {}) {
    const shell = document.getElementById('appShell');
    if (!shell) return;

    const content = `
      ${renderHeader()}
      ${renderStats({ showSettingsIcon: !settingsMode })}
      ${settingsMode ? renderHealthPanelShell() : ''}
      ${settingsMode ? renderStatisticsShell() : ''}
      ${renderProtectionControls({ showZapper: !settingsMode })}
      ${renderFilterListShell()}
      ${renderProxyShell({ settingsMode })}
      ${settingsMode ? renderLocalZapperShell() : ''}
      ${renderRequestLogShell()}
      ${renderFooter()}
    `;

    shell.innerHTML = settingsMode ? `<div class="main-container">${content}</div>` : content;
  }

  return {
    renderHeader,
    renderStats,
    renderStatisticsShell,
    renderProtectionControls,
    renderHealthPanelShell,
    renderFilterListShell,
    renderProxyShell,
    renderLocalZapperShell,
    renderRequestLogShell,
    renderFooter,
    renderPageShell
  };
})();

globalThis.ChromaComponents = ChromaComponents;
