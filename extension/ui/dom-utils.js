/**
 * Chroma Ad-Blocker - Shared DOM helpers for extension UI pages.
 */

'use strict';

globalThis.ChromaDom = (() => {
  const $ = id => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function appendElement(parent, tagName, className = '', textContent = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (textContent !== '') element.textContent = textContent;
    parent.appendChild(element);
    return element;
  }

  function clearElement(element) {
    while (element?.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function setHidden(element, hidden) {
    element?.classList.toggle('is-hidden', hidden);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function isActivationKey(event) {
    return event?.key === 'Enter' || event?.key === ' ';
  }

  function addKeyboardActivation(element, handler) {
    if (!element) return;
    element.addEventListener('click', handler);
    element.addEventListener('keydown', (event) => {
      if (!isActivationKey(event)) return;
      event.preventDefault();
      handler(event);
    });
  }

  return {
    $,
    escapeHTML,
    appendElement,
    clearElement,
    setHidden,
    setText,
    isActivationKey,
    addKeyboardActivation
  };
})();
