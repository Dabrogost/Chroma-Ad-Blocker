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
    <button id="settingsIcon" class="settings-icon" type="button" title="Open Settings" aria-label="Open Settings">
    <svg class="settings-icon__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
    </button>
  `;

  const plusIcon = `
    <svg class="icon-action-btn__icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `;

  function renderSkeletonLine(className = '') {
    return `<div class="skeleton-line${className ? ` ${className}` : ''}" aria-hidden="true"></div>`;
  }

  function renderSkeletonRows(count = 3, className = '') {
    return Array.from({ length: count }, (_, index) => `
      <div class="skeleton-row${className ? ` ${className}` : ''}" aria-hidden="true">
        <div class="skeleton-row__content">
          ${renderSkeletonLine(index % 2 ? 'skeleton-line--medium' : 'skeleton-line--long')}
          ${renderSkeletonLine(index % 2 ? 'skeleton-line--long' : 'skeleton-line--short')}
        </div>
        ${renderSkeletonLine('skeleton-line--pill')}
      </div>
    `).join('');
  }

  function renderSkeletonCards(count = 4, className = '') {
    return Array.from({ length: count }, (_, index) => `
      <div class="skeleton-card${className ? ` ${className}` : ''}" aria-hidden="true">
        ${renderSkeletonLine(index % 2 ? 'skeleton-line--medium' : 'skeleton-line--short')}
        ${renderSkeletonLine('skeleton-line--value')}
      </div>
    `).join('');
  }

  function renderSkeletonGrid(count = 4, className = '') {
    return `
      <div class="skeleton-grid${className ? ` ${className}` : ''}" aria-hidden="true">
        ${renderSkeletonCards(count)}
      </div>
    `;
  }

  function renderHealthSkeletonSection(titleWidthClass, metricCount, { wide = false } = {}) {
    return `
      <div class="health-section health-section--skeleton${wide ? ' health-section--wide' : ''}" aria-hidden="true">
        <div class="health-section__title">
          ${renderSkeletonLine(titleWidthClass)}
        </div>
        ${Array.from({ length: metricCount }, (_, index) => `
          <div class="health-metric health-skeleton-metric">
            ${renderSkeletonLine(index % 2 ? 'skeleton-line--medium' : 'skeleton-line--long')}
            ${renderSkeletonLine(index % 3 ? 'skeleton-line--short' : 'skeleton-line--medium')}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderHealthSkeleton() {
    return [
      renderHealthSkeletonSection('skeleton-line--short', 6),
      renderHealthSkeletonSection('skeleton-line--medium', 5),
      renderHealthSkeletonSection('skeleton-line--medium', 5),
      renderHealthSkeletonSection('skeleton-line--short', 3),
      renderHealthSkeletonSection('skeleton-line--medium', 2),
      renderHealthSkeletonSection('skeleton-line--short', 5),
      renderHealthSkeletonSection('skeleton-line--medium', 5),
      renderHealthSkeletonSection('skeleton-line--short', 3),
      renderHealthSkeletonSection('skeleton-line--short', 1, { wide: true })
    ].join('');
  }

  function renderSkeletonBars(count = 5) {
    return Array.from({ length: count }, (_, index) => `
      <div class="skeleton-row skeleton-row--timeline" aria-hidden="true">
        <div class="skeleton-row__content">
          ${renderSkeletonLine('skeleton-line--short')}
          <div class="skeleton-bar skeleton-bar--${(index % 5) + 1}"></div>
        </div>
        ${renderSkeletonLine('skeleton-line--tiny')}
      </div>
    `).join('');
  }

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
              <input type="checkbox" id="toggleEnabled" checked aria-label="Enable Chroma protection" />
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

  function renderToggleRow({ inputId, rowId = '', rowClass = '', name, desc, badge = '', label = name }) {
    return `
      <div class="toggle-row${rowClass ? ` ${rowClass}` : ''}"${rowId ? ` id="${rowId}"` : ''}>
        <div class="toggle-info">
          <div class="name">${name}${badge}</div>
          <div class="desc">${desc}</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="${inputId}" aria-label="${label}" />
          <span class="slider"></span>
        </label>
      </div>
    `;
  }

  function renderZapperRow() {
    return `
      <div class="toggle-row zapper-action-row">
        <div class="toggle-info">
          <div class="name">Element Zapper</div>
          <div class="desc" id="zapperStatus">Pick one page element to hide</div>
        </div>
        <button class="reset-btn" id="zapElementBtn">Zap Element</button>
      </div>
    `;
  }

  function renderSiteQuickActions() {
    return `
      <div class="section-title">This Site</div>
      <div class="protection-list">
        ${renderZapperRow()}
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

  function renderSettingsNav() {
    const links = [
      ['#protectionSection', 'Protection'],
      ['#filterListsSection', 'Lists'],
      ['#proxySection', 'Proxy'],
      ['#healthSection', 'Health'],
      ['#statsSection', 'Stats'],
      ['#updatesSection', 'Updates'],
      ['#userScriptletsSection', 'Scriptlets'],
      ['#zapperRulesSection', 'Zapper'],
      ['#requestLogSection', 'Log']
    ];

    return `
      <nav class="settings-nav" aria-label="Settings sections">
        ${links.map(([href, label]) => `<a class="settings-nav__link" href="${href}">${label}</a>`).join('')}
      </nav>
    `;
  }

  function renderProtectionControls() {
    return `
      <div class="section-title" id="protectionSection">Protection Layers</div>
      <div class="protection-list">
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
            <button class="speed-btn" data-speed="4" aria-label="Set acceleration speed to 4x">&times;4</button>
            <button class="speed-btn" data-speed="8" aria-label="Set acceleration speed to 8x">&times;8</button>
            <button class="speed-btn" data-speed="12" aria-label="Set acceleration speed to 12x">&times;12</button>
            <button class="speed-btn" data-speed="16" aria-label="Set acceleration speed to 16x">&times;16</button>
          </div>
        </div>
        ${renderToggleRow({
          inputId: 'toggleCosmetic',
          name: 'Cosmetic Filtering',
          desc: 'Hides banners, sponsored slots, overlays'
        })}
        ${renderToggleRow({
          inputId: 'toggleTrackingUrlCleanup',
          name: 'Tracking URL Cleanup',
          desc: 'Removes known tracking parameters from page URLs'
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
          inputId: 'toggleQuietConsole',
          name: 'Quiet Console',
          desc: 'Opt-in adblock noise reduction in page DevTools'
        })}
        ${renderToggleRow({
          inputId: 'toggleFingerprintRandomization',
          rowClass: 'fpr-toggle-row',
          name: 'Fingerprint Randomization',
          badge: '<span class="badge purple" title="May affect bot checks, captchas, or device checks">Compat</span>',
          desc: 'Per-page canvas, audio, WebGL, navigator, and language API farbling'
        })}
        ${renderToggleRow({
          inputId: 'toggleBrowserPrivacyHardening',
          name: 'Chrome Privacy Hardening',
          desc: 'Blocks third-party cookies, keeps DNT off, and disables Chrome ad APIs'
        })}
        ${renderToggleRow({
          inputId: 'toggleGeolocationProtection',
          name: 'Geolocation Protection',
          desc: 'Blocks sites from accessing your real physical location'
        })}
        ${renderToggleRow({
          inputId: 'toggleDeAmpLinks',
          name: 'De-AMP Links',
          desc: 'Redirects supported AMP viewer pages to publisher URLs'
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

  function renderFilterListShell({ settingsMode = false } = {}) {
    return `
      <div class="section-title section-title--inline" id="filterListsSection">
        <span class="section-title-text">Filter Lists</span>
        <button id="addSubscriptionBtn" class="reset-btn icon-action-btn" title="Add Filter List" aria-label="Add Filter List" type="button">
          ${plusIcon}
        </button>
      </div>
      <div id="addSubscriptionForm" class="protection-list add-subscription-form is-hidden">
        <div class="add-subscription-grid">
          <input type="text" id="newSubName" class="chroma-input chroma-input--compact" placeholder="Name (optional)" />
          <input type="text" id="newSubUrl" class="chroma-input chroma-input--compact" placeholder="https://example.com/list.txt" />
          <div id="newSubError" class="form-error is-hidden"></div>
          <div class="form-actions">
            <button id="newSubAddBtn" class="reset-btn form-submit-btn action-btn action-btn--primary">Add</button>
            <button id="newSubCancelBtn" class="reset-btn inline-danger-btn compact-action-btn action-btn action-btn--danger" title="Cancel" aria-label="Cancel adding filter list" type="button">Cancel</button>
          </div>
        </div>
      </div>
      <div class="protection-list" id="subscriptionList">
        ${settingsMode ? renderSkeletonRows(3, 'subscription-skeleton-row') : `
          <div class="toggle-row loading-row">
            <span class="loading-text">Loading subscriptions...</span>
          </div>
        `}
      </div>
    `;
  }

  function renderHealthPanelShell() {
    return `
      <div class="section-title section-title--spaced" id="healthSection">Health</div>
      <div class="protection-list health-panel" id="healthPanel">
        <div class="health-header">
          <div class="toggle-info">
            <div class="name">Overall: <span id="healthOverallLabel" class="health-status health-status--disabled">Loading</span></div>
            <div class="desc" id="healthVersionText">Checking protection layers...</div>
          </div>
          <button class="reset-btn compact-action-btn action-btn" id="refreshHealthBtn" disabled>Refresh Health</button>
        </div>
        <div class="health-summary is-loading" id="healthSummary" aria-label="Health summary">
          <span class="health-summary-chip health-summary-chip--loading">Loading health...</span>
        </div>
        <details class="settings-detail health-detail">
          <summary class="settings-detail__summary">
            <span class="settings-detail__title">Diagnostic details</span>
            <span class="settings-detail__hint" aria-hidden="true"></span>
          </summary>
          <div class="health-grid is-loading" id="healthPanelBody">
            ${renderHealthSkeleton()}
          </div>
        </details>
      </div>
    `;
  }

  function renderUpdaterShell() {
    return `
      <div class="section-title section-title--spaced" id="updatesSection">Updates</div>
      <div class="protection-list updater-panel" id="updaterPanel">
        <div class="updater-header">
          <div class="toggle-info updater-status-copy">
            <div class="name" id="updaterStatusTitle">Update Setup</div>
            <div class="desc" id="updaterStatusDesc">Choose the unpacked Chroma folder that contains manifest.json.</div>
          </div>
        </div>
        <div class="updater-step-list" aria-label="Updater setup steps">
          <div class="updater-step" id="updaterStepSupport">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Folder access available</span>
          </div>
          <div class="updater-step" id="updaterStepFolder">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Chroma folder verified</span>
          </div>
          <div class="updater-step" id="updaterStepRelease">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Release assets identified</span>
          </div>
          <div class="updater-step" id="updaterStepPackage">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Package ZIP inspected</span>
          </div>
          <div class="updater-step" id="updaterStepPlan">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Install plan built</span>
          </div>
          <div class="updater-step" id="updaterStepWrite">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Write probe passed</span>
          </div>
          <div class="updater-step" id="updaterStepInstall">
            <span class="updater-step__dot updater-step__dot--pending" aria-hidden="true"></span>
            <span class="updater-step__label">Update installed</span>
          </div>
        </div>
        <div class="updater-actions">
          <div class="updater-action-group updater-action-group--release">
            <div class="updater-action-group__label">Release</div>
            <div class="updater-action-buttons">
              <button class="reset-btn compact-action-btn action-btn" id="checkLatestReleaseBtn" type="button">Check Latest Release</button>
            </div>
          </div>
          <div class="updater-action-group updater-action-group--folder">
            <div class="updater-action-group__label">Folder</div>
            <div class="updater-action-buttons">
              <button class="reset-btn compact-action-btn action-btn" id="chooseInstallFolderBtn" type="button">Choose Chroma Folder</button>
            </div>
          </div>
          <div class="updater-action-group updater-action-group--package">
            <div class="updater-action-group__label">Package</div>
            <div class="updater-action-buttons">
              <button class="reset-btn compact-action-btn action-btn" id="inspectPackageBtn" type="button">Inspect Package ZIP</button>
              <button class="reset-btn compact-action-btn action-btn" id="buildInstallPlanBtn" type="button">Build Install Plan</button>
              <button class="reset-btn compact-action-btn action-btn" id="runFolderProbeBtn" type="button" disabled>Run Write Probe</button>
            </div>
          </div>
          <div class="updater-action-group updater-action-group--install">
            <div class="updater-action-group__label">Install</div>
            <div class="updater-action-buttons">
              <button class="reset-btn compact-action-btn action-btn action-btn--primary" id="installUpdateBtn" type="button" disabled>Install Update</button>
            </div>
          </div>
        </div>
        <div class="updater-plan" id="updaterPlanSummary" hidden>
          <div class="updater-plan__counts" aria-label="Install plan summary">
            <div class="updater-plan__count">
              <span class="updater-plan__number" id="updaterPlanAddCount">0</span>
              <span class="updater-plan__label">Add</span>
            </div>
            <div class="updater-plan__count">
              <span class="updater-plan__number" id="updaterPlanOverwriteCount">0</span>
              <span class="updater-plan__label">Overwrite</span>
            </div>
            <div class="updater-plan__count">
              <span class="updater-plan__number" id="updaterPlanRemoveCount">0</span>
              <span class="updater-plan__label">Remove</span>
            </div>
            <div class="updater-plan__count">
              <span class="updater-plan__number" id="updaterPlanIgnoreCount">0</span>
              <span class="updater-plan__label">Ignore</span>
            </div>
          </div>
          <div class="updater-plan__preview" id="updaterPlanPreview"></div>
        </div>
        <div class="updater-progress" id="updaterProgress" hidden>
          <div class="updater-progress__track">
            <div class="updater-progress__fill" id="updaterProgressFill"></div>
          </div>
          <div class="updater-progress__text" id="updaterProgressText">Waiting</div>
        </div>
        <div class="updater-result-row">
          <div class="desc updater-result" id="updaterResult" role="status" aria-live="polite"></div>
          <button class="reset-btn compact-action-btn action-btn action-btn--primary" id="reloadChromaBtn" type="button" hidden disabled>Reload Chroma</button>
        </div>
      </div>
    `;
  }

  function renderStatisticsShell({ settingsMode = false } = {}) {
    return `
      <div class="section-title section-title--spaced" id="statsSection">Protection Intelligence</div>
      <div class="protection-list stats-panel" id="statisticsPanel">
        <div class="stats-panel-header">
          <div class="toggle-info">
            <div class="name">Local Analytics</div>
            <div class="desc">All statistics are stored locally. Full request URLs are only kept when Debug Mode is enabled.</div>
          </div>
        </div>

        <div class="stats-card-grid is-loading" id="statisticsTopCards">
          ${renderSkeletonCards(8)}
        </div>

        <div class="stats-subsection">
          <div class="stats-subsection-title">Overview</div>
          <div class="stats-range-grid is-loading" id="statsRangeSummary">
            ${renderSkeletonCards(4)}
          </div>
        </div>

        <details class="settings-detail stats-detail">
          <summary class="settings-detail__summary">
            <span class="settings-detail__title">Activity detail</span>
            <span class="settings-detail__hint" aria-hidden="true"></span>
          </summary>

          <div class="stats-subsection">
            <div class="stats-subsection-title">Sites</div>
            <div class="stats-list is-loading" id="statsSitesList">
              ${renderSkeletonRows(4)}
            </div>
          </div>

          <div class="stats-subsection">
            <div class="stats-subsection-title">Rules</div>
            <div class="stats-list is-loading" id="statsRulesList">
              ${renderSkeletonRows(4)}
            </div>
          </div>

          <div class="stats-subsection">
            <div class="stats-subsection-title">Timeline</div>
            <div class="stats-timeline is-loading" id="statsTimelineList">
              ${renderSkeletonBars(5)}
            </div>
          </div>

          <div class="stats-subsection">
            <div class="stats-subsection-title">Events</div>
            <div class="stats-list is-loading" id="statsEventsList">
              ${renderSkeletonRows(4)}
            </div>
          </div>
        </details>

        <details class="settings-detail stats-detail">
          <summary class="settings-detail__summary">
            <span class="settings-detail__title">Privacy and exports</span>
            <span class="settings-detail__hint" aria-hidden="true"></span>
          </summary>

          <div class="stats-subsection stats-privacy">
            <div class="stats-subsection-title">Privacy</div>
            <div class="stats-controls-grid">
              <select id="statsModeSelect" class="chroma-input chroma-input--compact control-pending" disabled>
                <option value="basic">Basic: totals only</option>
                <option value="aggregated">Aggregated: domains and rule sources</option>
                <option value="debug">Debug: include recent full URLs</option>
              </select>
              <select id="statsRetentionSelect" class="chroma-input chroma-input--compact control-pending" disabled>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">365 days</option>
              </select>
            </div>
            <div class="stats-actions">
              <button class="reset-btn compact-action-btn action-btn action-btn--danger" id="resetAllStats">Reset all stats</button>
              <button class="reset-btn compact-action-btn action-btn action-btn--danger" id="resetSiteStats">Reset site stats</button>
              <button class="reset-btn compact-action-btn action-btn action-btn--danger" id="resetRequestLogOnly">Reset request log</button>
              <button class="reset-btn compact-action-btn action-btn" id="exportStatsJson">Export JSON</button>
            </div>
          </div>

          ${settingsMode ? `
            <div class="stats-subsection settings-backup">
              <div class="stats-subsection-title">Settings Backup</div>
              <div class="stats-actions">
                <button class="reset-btn compact-action-btn action-btn" id="exportConfigJson">Export settings</button>
                <button class="reset-btn compact-action-btn action-btn" id="importConfigJson">Import settings</button>
                <input type="file" id="importConfigFile" class="visually-hidden" accept="application/json,.json" />
              </div>
              <div class="desc settings-backup-status" id="settingsBackupStatus"></div>
            </div>
          ` : ''}
        </details>
      </div>
    `;
  }

  function renderUserScriptletsShell() {
    return `
      <div class="section-title section-title--inline" id="userScriptletsSection">
        <span class="section-title-text">User Scriptlets</span>
        <button id="addUserScriptletSourceBtn" class="reset-btn compact-action-btn user-scriptlet-add-btn" title="Add Resource URL" aria-label="Add Resource URL" type="button">
          ${plusIcon}
          <span>Add URL</span>
        </button>
      </div>
      <div class="protection-list user-scriptlet-panel is-loading" id="userScriptletPanel">
        <div class="user-scriptlet-warning">
          User scriptlet resources run code you choose through Chrome's User Scripts API. Add only resources you trust.
        </div>
        <div class="user-scriptlet-overview is-loading" id="userScriptletOverview" aria-label="User scriptlet summary">
          <div class="user-scriptlet-overview-card">
            <span class="user-scriptlet-overview-card__label">Sources</span>
            <span class="user-scriptlet-overview-card__value" id="userScriptletSourceCount">...</span>
          </div>
          <div class="user-scriptlet-overview-card">
            <span class="user-scriptlet-overview-card__label">Resources</span>
            <span class="user-scriptlet-overview-card__value" id="userScriptletResourceCount">...</span>
          </div>
          <div class="user-scriptlet-overview-card">
            <span class="user-scriptlet-overview-card__label">Rules</span>
            <span class="user-scriptlet-overview-card__value" id="userScriptletRuleCount">...</span>
          </div>
          <div class="user-scriptlet-overview-card">
            <span class="user-scriptlet-overview-card__label">Missing</span>
            <span class="user-scriptlet-overview-card__value" id="userScriptletMissingCount">...</span>
          </div>
        </div>
        <div id="addUserScriptletSourceForm" class="user-scriptlet-source-form is-hidden">
          <div class="add-subscription-grid">
            <input type="text" id="newUserScriptletSourceName" class="chroma-input chroma-input--compact" placeholder="Name (optional)" />
            <input type="text" id="newUserScriptletSourceUrl" class="chroma-input chroma-input--compact" placeholder="https://example.com/scriptlet-resources.js" />
            <div id="newUserScriptletSourceError" class="form-error is-hidden"></div>
            <div class="form-actions">
              <button id="newUserScriptletSourceAddBtn" class="reset-btn form-submit-btn action-btn action-btn--primary">Add</button>
              <button id="newUserScriptletSourceCancelBtn" class="reset-btn inline-danger-btn compact-action-btn action-btn action-btn--danger" title="Cancel" aria-label="Cancel adding user scriptlet resource" type="button">Cancel</button>
            </div>
          </div>
        </div>
        <div class="user-scriptlet-subsection-title">Resource URLs</div>
        <div id="userScriptletSourceList" class="user-scriptlet-source-list">
          ${renderSkeletonRows(2, 'user-scriptlet-skeleton-row')}
        </div>
        <div class="user-scriptlet-available" id="userScriptletAvailableResources">
          <div class="user-scriptlet-subsection-title">Available Resources</div>
          <div class="user-scriptlet-chip-list is-loading" id="userScriptletAvailableResourceList">
            ${renderSkeletonLine('skeleton-line--long')}
          </div>
        </div>
        <details class="settings-detail user-scriptlet-rules-detail">
          <summary class="settings-detail__summary">
            <span class="settings-detail__title">Rules editor</span>
            <span class="settings-detail__hint" aria-hidden="true"></span>
          </summary>
          <div class="user-scriptlet-rules">
            <div class="user-scriptlet-subsection-title">Rules</div>
            <textarea id="userScriptletRulesText" class="chroma-input user-scriptlet-rules-text control-pending" spellcheck="false" readonly aria-busy="true" placeholder="example.com##+js(resource-name)&#10;another.example##+js(other-resource)"></textarea>
            <div class="user-scriptlet-rule-actions">
              <div id="userScriptletRulesStatus" class="desc user-scriptlet-rules-status">Loading rules...</div>
              <button id="saveUserScriptletRulesBtn" class="reset-btn compact-action-btn action-btn action-btn--primary control-pending" type="button" disabled>Save Rules</button>
            </div>
          </div>
        </details>
      </div>
    `;
  }

  function renderProxyShell({ settingsMode }) {
    return `
      <div class="section-title section-title--inline"${settingsMode ? ' id="proxySection"' : ''}>
        <span class="section-title-text">Media Proxy Router</span>
        ${settingsMode ? `
          <button id="addProxyServerBtn" class="reset-btn icon-action-btn" title="Add Proxy Server" aria-label="Add Proxy Server" type="button">
            ${plusIcon}
          </button>
        ` : ''}
      </div>
      <div id="proxyRouterContainer">
        ${settingsMode ? renderSkeletonRows(2, 'proxy-skeleton-row') : '<!-- Proxy entries will be injected here -->'}
      </div>
    `;
  }

  function renderLocalZapperShell() {
    return `
      <div class="section-title section-title--spaced" id="zapperRulesSection">Local Zapper Rules</div>
      <div class="protection-list zapper-rules-panel">
        <div class="zapper-overview" id="zapperOverview" aria-label="Local zapper summary">
          <div class="zapper-overview-card">
            <span class="zapper-overview-card__label">Domains</span>
            <span class="zapper-overview-card__value" id="zapperDomainCount">0</span>
          </div>
          <div class="zapper-overview-card">
            <span class="zapper-overview-card__label">Rules</span>
            <span class="zapper-overview-card__value" id="zapperRuleCount">0</span>
          </div>
          <div class="zapper-overview-card">
            <span class="zapper-overview-card__label">Enabled</span>
            <span class="zapper-overview-card__value" id="zapperEnabledCount">0</span>
          </div>
          <div class="zapper-overview-card">
            <span class="zapper-overview-card__label">Paused</span>
            <span class="zapper-overview-card__value" id="zapperDisabledCount">0</span>
          </div>
        </div>
        <details class="settings-detail zapper-rules-detail">
          <summary class="settings-detail__summary">
            <span class="settings-detail__title">Saved selectors <span id="zapperRulesSummaryCount">0</span></span>
            <span class="settings-detail__hint" aria-hidden="true"></span>
          </summary>
          <div class="zapper-rule-list" id="localZapperRules">
            ${renderSkeletonRows(3, 'zapper-skeleton-row')}
          </div>
        </details>
      </div>
    `;
  }

  function renderRequestLogShell() {
    return `
      <div class="section-title section-title--spaced" id="requestLogSection">Request Log</div>
      <div class="protection-list request-log-panel" id="requestLogPanel">
        <div class="request-log-summary" id="requestLogSummary" aria-label="Request log summary">
          <div class="request-log-summary-card">
            <span class="request-log-summary-card__label">Entries</span>
            <span class="request-log-summary-card__value" id="logEntryCount">0</span>
          </div>
          <div class="request-log-summary-card">
            <span class="request-log-summary-card__label">Types</span>
            <span class="request-log-summary-card__value" id="logTypeCount">0</span>
          </div>
          <div class="request-log-summary-card">
            <span class="request-log-summary-card__label">Latest</span>
            <span class="request-log-summary-card__value request-log-summary-card__value--small" id="logLatestTime">None</span>
          </div>
          <div class="request-log-summary-card">
            <span class="request-log-summary-card__label">State</span>
            <span class="request-log-summary-card__value request-log-summary-card__value--small" id="logStreamState">Live</span>
          </div>
        </div>
        <div class="log-header" id="logToggleRow" role="button" tabindex="0" aria-expanded="false" aria-controls="logEntries">
          <div class="toggle-info">
            <div class="name">Matched Requests</div>
            <div class="desc" id="logHeaderDesc">Rules fired on this session</div>
          </div>
          <div class="log-actions">
            <button class="reset-btn compact-action-btn action-btn log-freeze-btn" id="logFreezeBtn" title="Freeze request log" aria-label="Freeze request log" type="button">Freeze</button>
            <button class="log-toggle-btn" id="logToggleBtn" title="Expand log" aria-label="Expand request log" type="button">&#x25bc;</button>
          </div>
        </div>
        <div class="log-entries" id="logEntries">
          <div class="log-empty">No entries yet.</div>
        </div>
      </div>
    `;
  }

  function renderFooter({ showResetStats = true } = {}) {
    return `
      <footer>
        ${showResetStats ? '<button class="reset-btn compact-action-btn action-btn action-btn--danger" id="resetStats">Reset Stats</button>' : ''}
        <div class="footer-right">
          <a href="https://github.com/Dabrogost/Chroma-Ad-Blocker" target="_blank" class="github-link" title="View Source on GitHub">
            ${githubIcon}
          </a>
          <span class="version" id="versionText">v1.3.0 &middot; MV3</span>
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
      ${settingsMode ? renderSettingsNav() : ''}
      ${settingsMode ? renderProtectionControls() : renderSiteQuickActions()}
      ${settingsMode ? renderFilterListShell({ settingsMode }) : ''}
      ${settingsMode ? renderProxyShell({ settingsMode }) : ''}
      ${settingsMode ? renderHealthPanelShell() : ''}
      ${settingsMode ? renderStatisticsShell({ settingsMode }) : ''}
      ${settingsMode ? renderUpdaterShell() : ''}
      ${settingsMode ? renderUserScriptletsShell() : ''}
      ${settingsMode ? renderLocalZapperShell() : ''}
      ${settingsMode ? renderRequestLogShell() : ''}
      ${renderFooter({ showResetStats: settingsMode })}
    `;

    shell.innerHTML = settingsMode ? `<div class="main-container">${content}</div>` : content;
  }

  return {
    renderHeader,
    renderStats,
    renderSettingsNav,
    renderSiteQuickActions,
    renderStatisticsShell,
    renderUpdaterShell,
    renderProtectionControls,
    renderHealthPanelShell,
    renderFilterListShell,
    renderUserScriptletsShell,
    renderProxyShell,
    renderLocalZapperShell,
    renderRequestLogShell,
    renderFooter,
    renderPageShell
  };
})();

globalThis.ChromaComponents = ChromaComponents;
