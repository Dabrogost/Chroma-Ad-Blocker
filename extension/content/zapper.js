(function() {
  'use strict';

  const ROOT_ATTR = 'data-chroma-zapper';
  const MENU_ATTR = 'data-chroma-zapper-menu';
  const MAX_SELECTOR_LEN = 512;
  const MAX_SELECTOR_MATCHES = 5;
  const WARN_SELECTOR_MATCHES = 1;
  const BLOCKED_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'IFRAME']);
  const RANDOM_RE = /(?:^|[-_])(?:\d{4,}|[a-f0-9]{8,}|[a-z0-9]{10,})(?:$|[-_])/i;
  const ZAPPER_FONT = '12px/1.25 system-ui,-apple-system,Segoe UI,sans-serif';
  const PANEL_STYLES = {
    position: 'fixed',
    zIndex: '2147483647',
    background: '#080815',
    border: '1px solid rgba(0,255,204,0.55)',
    borderRadius: '8px',
    boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
    font: ZAPPER_FONT
  };
  const OUTLINE_STYLES = {
    position: 'fixed',
    zIndex: '2147483646',
    pointerEvents: 'none',
    border: '2px solid #00ffcc',
    background: 'rgba(0,255,204,0.08)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.45),0 0 20px rgba(0,255,204,0.35)',
    display: 'none'
  };
  const TOOLTIP_STYLES = {
    ...PANEL_STYLES,
    pointerEvents: 'none',
    padding: '4px 8px',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    color: '#fff',
    font: '12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif',
    display: 'none'
  };
  const MENU_STYLES = {
    ...PANEL_STYLES,
    display: 'flex',
    gap: '6px',
    padding: '8px'
  };
  const SAVE_MENU_STYLES = {
    ...PANEL_STYLES,
    display: 'grid',
    gap: '7px',
    maxWidth: '320px',
    padding: '9px',
    color: '#fff'
  };
  const BUTTON_STYLES = {
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '6px',
    background: 'rgba(255,255,255,0.06)',
    color: '#fff',
    padding: '6px 9px',
    cursor: 'pointer',
    font: 'inherit'
  };
  const SELECTOR_PREVIEW_STYLES = {
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    font: '11px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace',
    color: '#00ffcc'
  };
  const SAVE_ACTION_STYLES = {
    display: 'flex',
    gap: '6px',
    justifyContent: 'flex-end'
  };

  let token = null;
  let active = false;
  let current = null;
  let outline = null;
  let tooltip = null;
  let menu = null;
  let pendingSelector = null;
  let lastMenuPoint = { x: 12, y: 12 };

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  }

  function isStableIdent(value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 64 &&
      /^[a-zA-Z_][\w-]*$/.test(value) &&
      !RANDOM_RE.test(value)
    );
  }

  function stableClasses(el) {
    return Array.from(el.classList || [])
      .filter(isStableIdent)
      .slice(0, 3);
  }

  function selectorPart(el, forceNth) {
    const tag = el.localName;
    if (!forceNth && isStableIdent(el.id)) return `#${cssEscape(el.id)}`;

    const classes = stableClasses(el);
    let part = tag;
    if (classes.length > 0) {
      part += classes.map(cls => `.${cssEscape(cls)}`).join('');
    }

    if (forceNth || classes.length === 0) {
      let index = 1;
      let sibling = el;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.localName === el.localName) index++;
      }
      part += `:nth-of-type(${index})`;
    }
    return part;
  }

  function analyzeSelector(selector, target) {
    if (typeof selector !== 'string') return false;
    const value = selector.trim();
    if (!value || value.length > MAX_SELECTOR_LEN) return { ok: false, error: 'Selector is too long' };
    if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, error: 'Selector contains unsupported characters' };
    if (/^\s*(\/|xpath\s*:)/i.test(value)) return { ok: false, error: 'XPath selectors are not supported' };
    if (/(^|[^\\]):has\s*\(/i.test(value)) return { ok: false, error: ':has() selectors are not supported' };
    if (/[{};]/.test(value)) return { ok: false, error: 'Selector contains unsupported CSS syntax' };

    let matches;
    try {
      matches = document.querySelectorAll(value);
    } catch {
      return { ok: false, error: 'Selector is invalid' };
    }
    if (matches.length === 0) return { ok: false, error: 'Selector matches nothing' };
    if (matches.length > MAX_SELECTOR_MATCHES) {
      return { ok: false, error: `Selector matches ${matches.length} elements` };
    }
    if (!Array.from(matches).includes(target)) {
      return { ok: false, error: 'Selector does not match the selected element' };
    }
    return { ok: true, selector: value, count: matches.length };
  }

  function isValidSelector(selector, target) {
    return analyzeSelector(selector, target).ok === true;
  }

  function generateSelectorInfo(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (isStableIdent(el.id)) {
      const selector = `#${cssEscape(el.id)}`;
      const result = analyzeSelector(selector, el);
      if (result.ok) return result;
    }

    const classSelector = selectorPart(el, false);
    if (stableClasses(el).length > 0) {
      const result = analyzeSelector(classSelector, el);
      if (result.ok) return result;
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      parts.unshift(selectorPart(node, true));
      const selector = parts.join(' > ');
      if (selector.length > MAX_SELECTOR_LEN) break;
      const result = analyzeSelector(selector, el);
      if (result.ok) return result;
      node = node.parentElement;
    }

    return null;
  }

  function generateSelector(el) {
    return generateSelectorInfo(el)?.selector || null;
  }

  function isIgnoredElement(el) {
    return !el ||
      el.nodeType !== Node.ELEMENT_NODE ||
      BLOCKED_TAGS.has(el.tagName) ||
      el.closest(`[${ROOT_ATTR}]`);
  }

  function selectableFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const item of path) {
      if (item instanceof Element && !isIgnoredElement(item)) return item;
    }
    return null;
  }

  function makeRoot(tag) {
    const el = document.createElement(tag);
    el.setAttribute(ROOT_ATTR, 'true');
    return el;
  }

  function applyStyles(element, styles) {
    Object.assign(element.style, styles);
  }

  function ensureUi() {
    if (outline) return;

    outline = makeRoot('div');
    applyStyles(outline, OUTLINE_STYLES);

    tooltip = makeRoot('div');
    applyStyles(tooltip, TOOLTIP_STYLES);
    tooltip.textContent = 'Click to zap. Esc to cancel.';

    document.documentElement.append(outline, tooltip);
  }

  function showMessage(text) {
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.style.display = 'block';
  }

  function updateOutline(el, x, y) {
    if (!el) {
      outline.style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }

    const rect = el.getBoundingClientRect();
    outline.style.display = 'block';
    outline.style.left = `${Math.max(0, rect.left)}px`;
    outline.style.top = `${Math.max(0, rect.top)}px`;
    outline.style.width = `${Math.max(0, rect.width)}px`;
    outline.style.height = `${Math.max(0, rect.height)}px`;

    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(window.innerWidth - 180, x + 12)}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - 32, y + 12)}px`;
  }

  function removeMenu() {
    if (menu) menu.remove();
    menu = null;
    pendingSelector = null;
  }

  function menuButton(action, label) {
    const button = makeRoot('button');
    button.type = 'button';
    button.dataset.action = action;
    button.textContent = label;
    applyStyles(button, BUTTON_STYLES);
    return button;
  }

  function positionMenu(x, y) {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - rect.width - 8, x)}px`;
    menu.style.top = `${Math.min(window.innerHeight - rect.height - 8, y)}px`;
  }

  function openMenu(x, y) {
    removeMenu();
    lastMenuPoint = { x, y };
    menu = makeRoot('div');
    menu.setAttribute(MENU_ATTR, 'true');
    applyStyles(menu, MENU_STYLES);

    const actions = [
      ['hideOnce', 'Hide once'],
      ['save', 'Save for this site'],
      ['cancel', 'Cancel']
    ];
    for (const [action, label] of actions) {
      menu.appendChild(menuButton(action, label));
    }

    document.documentElement.appendChild(menu);
    positionMenu(x, y);
  }

  function openSaveConfirmation(result) {
    removeMenu();
    pendingSelector = result;
    menu = makeRoot('div');
    menu.setAttribute(MENU_ATTR, 'true');
    applyStyles(menu, SAVE_MENU_STYLES);

    const selectorText = makeRoot('div');
    selectorText.textContent = result.selector;
    applyStyles(selectorText, SELECTOR_PREVIEW_STYLES);

    const warning = makeRoot('div');
    warning.textContent = result.count > WARN_SELECTOR_MATCHES
      ? `This selector matches ${result.count} elements. Save it anyway?`
      : 'Save this selector for the site?';
    warning.style.color = '#fff';

    const actions = makeRoot('div');
    applyStyles(actions, SAVE_ACTION_STYLES);
    actions.append(
      menuButton('confirmSave', 'Save'),
      menuButton('cancel', 'Cancel')
    );

    menu.append(selectorText, warning, actions);
    document.documentElement.appendChild(menu);
    positionMenu(lastMenuPoint.x, lastMenuPoint.y);
  }

  function sendFinish(action, extra = {}) {
    return chrome.runtime.sendMessage({
      type: 'ZAPPER_SAVE_RULE',
      action,
      token,
      ...extra
    }).catch(() => null);
  }

  function cleanup() {
    active = false;
    current = null;
    pendingSelector = null;
    removeMenu();
    outline?.remove();
    tooltip?.remove();
    outline = null;
    tooltip = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  }

  function finish(action) {
    if (action === 'cancel') {
      sendFinish('cancel').finally(cleanup);
      return;
    }

    if (!current) {
      sendFinish('cancel').finally(cleanup);
      return;
    }

    if (action === 'hideOnce') {
      current.style.setProperty('display', 'none', 'important');
      sendFinish('hideOnce').finally(cleanup);
      return;
    }

    if (action === 'save') {
      const selectorInfo = generateSelectorInfo(current);
      if (!selectorInfo) {
        showMessage('Could not create a safe selector.');
        return;
      }

      openSaveConfirmation(selectorInfo);
      return;
    }

    if (action === 'confirmSave') {
      const selectorInfo = pendingSelector;
      if (!selectorInfo) {
        showMessage('No selector is ready to save.');
        return;
      }

      const target = current;
      sendFinish('save', {
        domain: window.location.hostname,
        selector: selectorInfo.selector
      }).then((res) => {
        if (res?.ok) {
          target.style.setProperty('display', 'none', 'important');
          cleanup();
          return;
        }
        showMessage(res?.error || 'Could not save this rule.');
      });
    }
  }

  function onMove(event) {
    if (!active || menu) return;
    current = selectableFromEvent(event);
    updateOutline(current, event.clientX, event.clientY);
  }

  function onClick(event) {
    if (!active) return;
    const action = event.target?.closest?.(`[${MENU_ATTR}] button`)?.dataset?.action;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (action) {
      finish(action);
      return;
    }

    const target = selectableFromEvent(event);
    if (!target) return;
    current = target;
    openMenu(event.clientX, event.clientY);
  }

  function onKeydown(event) {
    if (!active || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    finish('cancel');
  }

  globalThis.__CHROMA_START_ZAPPER__ = function(sessionToken) {
    if (active) cleanup();
    token = sessionToken;
    active = true;
    ensureUi();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    showMessage('Click to zap. Esc to cancel.');
  };

  if (typeof globalThis !== 'undefined' && globalThis.__CHROMA_INTERNAL_TEST_STRICT__ === true) {
    globalThis.__CHROMA_ZAPPER_TEST__ = {
      generateSelector,
      generateSelectorInfo,
      isValidSelector,
      isStableIdent
    };
  }
})();
