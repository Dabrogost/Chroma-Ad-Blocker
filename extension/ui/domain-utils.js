/**
 * Chroma Ad-Blocker - UI domain helpers.
 * Uses a compact public-suffix set for extension UI site controls.
 */

'use strict';

globalThis.ChromaDomain = (() => {
  const EXACT_PUBLIC_SUFFIXES = new Set([
    'ac.jp', 'ac.nz', 'ac.uk',
    'appspot.com',
    'azurewebsites.net',
    'blogspot.com',
    'cloudfront.net',
    'co.il', 'co.in', 'co.jp', 'co.kr', 'co.nz', 'co.uk', 'co.za',
    'com.ar', 'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
    'edu.au', 'edu.cn', 'edu.hk', 'edu.sg',
    'firebaseapp.com',
    'github.io',
    'gov.au', 'gov.br', 'gov.cn', 'gov.hk', 'gov.sg', 'gov.uk',
    'herokuapp.com',
    'net.au', 'net.br', 'net.cn', 'net.hk', 'netlify.app',
    'ne.jp',
    'or.jp',
    'org.au', 'org.br', 'org.cn', 'org.hk', 'org.nz', 'org.sg', 'org.uk',
    'pages.dev',
    'sch.uk',
    'vercel.app',
    'web.app'
  ]);

  const EXCEPTION_PUBLIC_SUFFIXES = new Set([
    'city.kawasaki.jp',
    'city.kitakyushu.jp',
    'city.kobe.jp',
    'city.nagoya.jp',
    'city.sapporo.jp',
    'city.sendai.jp',
    'city.yokohama.jp',
    'metro.tokyo.jp',
    'www.ck'
  ]);

  const WILDCARD_PUBLIC_SUFFIXES = new Set([
    'bd',
    'ck',
    'er',
    'fk',
    'jm',
    'kh',
    'mm',
    'np',
    'pg',
    'sch.uk',
    'tz',
    'ye'
  ]);

  function normalizeHostname(hostname) {
    return String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
  }

  function getRegistrableDomain(hostname) {
    const host = normalizeHostname(hostname);
    if (!host || host.includes(':')) return '';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');

    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      if (EXCEPTION_PUBLIC_SUFFIXES.has(suffix)) {
        return labels.slice(i).join('.');
      }
    }

    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      const wildcardBase = labels.slice(i + 1).join('.');
      if (EXACT_PUBLIC_SUFFIXES.has(suffix) || WILDCARD_PUBLIC_SUFFIXES.has(wildcardBase)) {
        return labels.slice(Math.max(0, i - 1)).join('.');
      }
    }

    return labels.slice(-2).join('.');
  }

  return {
    normalizeHostname,
    getRegistrableDomain
  };
})();
