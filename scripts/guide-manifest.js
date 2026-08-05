'use strict';

/**
 * Canonical user-documentation inventory for the in-extension guide.
 *
 * Keep this list explicit. The docs directory also contains engineering,
 * maintainer, security-review, and machine-specific notes that must never be
 * pulled into the guide or release package by a glob.
 */

// Repository-only index used when a user document links back to the guide home.
const GUIDE_HUB_SOURCE = 'docs/README.md';

const GUIDE_CATEGORIES = [
  {
    id: 'start',
    title: 'Start Using Chroma',
    description: 'Install Chroma, learn the protection model, and choose a comfortable starting setup.'
  },
  {
    id: 'customize',
    title: 'Protect & Customize',
    description: 'Tune site protection, subscriptions, media routing, scriptlets, and local insights.'
  },
  {
    id: 'trust',
    title: 'Privacy & Trust',
    description: 'Understand requested permissions, local data, and optional network activity.'
  },
  {
    id: 'optimize',
    title: 'Tune Performance',
    description: 'Choose lower-overhead settings and troubleshoot resource-heavy protection layers.'
  },
  {
    id: 'project',
    title: 'Project Context',
    description: 'Read the project rationale, recommendations, license context, and terms.'
  }
];

const GUIDE_PAGES = [
  {
    source: 'docs/INSTALL.md',
    slug: 'install',
    title: 'Installation & Configuration',
    category: 'start',
    summary: 'Install or update Chroma, understand the main controls, import settings, and troubleshoot common setup issues.',
    tasks: ['Install Chroma', 'Update safely', 'Configure protection', 'Troubleshoot setup'],
    featured: true,
    settings: {
      path: 'ui/settings.html#protectionSection',
      label: 'Open protection settings'
    }
  },
  {
    source: 'docs/FEATURES.md',
    slug: 'features',
    title: 'Feature Guide',
    category: 'start',
    summary: "See how Chroma's blocking, cleanup, privacy, proxy, and page-level protection layers work together.",
    tasks: ['Choose protection layers', 'Learn feature defaults', 'Find site controls'],
    featured: true,
    settings: {
      path: 'ui/settings.html#protectionSection',
      label: 'Configure protection layers'
    }
  },
  {
    source: 'docs/YOUTUBE.md',
    slug: 'youtube',
    title: 'YouTube Protection',
    category: 'customize',
    summary: 'Understand YouTube payload cleanup, feed and Shorts handling, and the optional acceleration fallback.',
    tasks: ['Block YouTube ads', 'Clean Shorts and feeds', 'Use acceleration fallback'],
    settings: {
      path: 'ui/settings.html#protectionSection',
      label: 'Open YouTube protection settings'
    }
  },
  {
    source: 'docs/MEDIA_PROXY_ROUTER.md',
    slug: 'media-proxy-router',
    title: 'Media Proxy Router',
    category: 'customize',
    summary: 'Route selected media domains through a proxy without sending unrelated browser traffic through it.',
    tasks: ['Add a media route', 'Choose a proxy protocol', 'Prevent WebRTC leaks'],
    featured: true,
    settings: {
      path: 'ui/settings.html#proxySection',
      label: 'Open media proxy settings'
    }
  },
  {
    source: 'docs/FILTER_LISTS.md',
    slug: 'filter-lists',
    title: 'Filter List Subscriptions',
    category: 'customize',
    summary: 'Manage bundled and custom filter sources while understanding MV3 rule budgets and trust boundaries.',
    tasks: ['Manage filter lists', 'Add a custom list', 'Understand rule budgets'],
    settings: {
      path: 'ui/settings.html#filterListsSection',
      label: 'Manage filter lists'
    }
  },
  {
    source: 'docs/ADVANCED_USER_SCRIPTLETS.md',
    slug: 'advanced-user-scriptlets',
    title: 'Advanced User Scriptlets',
    category: 'customize',
    summary: 'Add trusted uBO-style scriptlet resources, connect rules to resources, and diagnose registration issues.',
    tasks: ['Add a scriptlet resource', 'Write a matching rule', 'Fix missing registrations'],
    settings: {
      path: 'ui/settings.html#userScriptletsSection',
      label: 'Open Advanced User Scriptlets'
    }
  },
  {
    source: 'docs/STATISTICS.md',
    slug: 'statistics',
    title: 'Statistics & Health',
    category: 'customize',
    summary: 'Use Protection Intelligence, privacy modes, local event history, exports, and Health diagnostics.',
    tasks: ['Review protection activity', 'Change stats privacy', 'Diagnose health'],
    featured: true,
    settings: {
      path: 'ui/settings.html#statsSection',
      label: 'Open Protection Intelligence'
    }
  },
  {
    source: 'docs/PERMISSIONS.md',
    slug: 'permissions',
    title: 'Permissions',
    category: 'trust',
    summary: 'Review every Chrome permission Chroma requests and the feature or safety boundary it supports.',
    tasks: ['Audit permissions', 'Understand broad host access']
  },
  {
    source: 'docs/PRIVACY_POLICY.md',
    slug: 'privacy-policy',
    title: 'Privacy Policy for Chroma Ad-Blocker',
    category: 'trust',
    summary: 'Learn what stays on your device and when optional features contact external services.',
    tasks: ['Review local data', 'Understand optional network requests']
  },
  {
    source: 'docs/PERFORMANCE.md',
    slug: 'performance',
    title: 'Performance Guide',
    category: 'optimize',
    summary: 'Understand where Chroma spends resources and choose lower-overhead settings for your browser.',
    tasks: ['Reduce overhead', 'Compare DNR and JavaScript cost', 'Tune heavier features'],
    settings: {
      path: 'ui/settings.html#protectionSection',
      label: 'Review protection settings'
    }
  },
  {
    source: 'docs/PROJECT_PHILOSOPHY.md',
    slug: 'project-philosophy',
    title: 'Project Philosophy',
    category: 'project',
    summary: 'Read why Chroma exists, why it is distributed outside the Chrome Web Store, and which alternatives fit other needs.',
    tasks: ['Understand project choices', 'Compare alternatives', 'Review AI disclosure']
  },
  {
    source: 'docs/ToS.md',
    slug: 'terms',
    title: 'Terms of Service for Chroma Ad-Blocker',
    category: 'project',
    summary: 'Review the terms, GPLv3 usage context, warranty disclaimer, and limitation of liability.',
    tasks: ['Review terms', 'Understand warranty limits']
  }
];

const GUIDE_ASSETS = [
  'docs/assets/docs-settings-health-panel.png',
  'docs/assets/docs-settings-overview.png',
  'docs/assets/docs-settings-protection-intelligence.png',
  'docs/assets/docs-settings-protection-layers.png',
  'docs/assets/docs-settings-proxy-router.png'
];

const USER_DOC_FILES = GUIDE_PAGES.map(page => page.source);

const GUIDE_REQUIRED_RELEASE_FILES = [
  'guide/index.html',
  'guide/guide.css',
  'guide/guide.js',
  'guide/search-index.json',
  ...GUIDE_PAGES.map(page => `guide/pages/${page.slug}.html`),
  ...GUIDE_ASSETS
];

function validateGuideManifest() {
  const categoryIds = new Set(GUIDE_CATEGORIES.map(category => category.id));
  const sources = new Set();
  const slugs = new Set();
  const errors = [];

  for (const page of GUIDE_PAGES) {
    if (!categoryIds.has(page.category)) {
      errors.push(`${page.source} uses unknown category ${page.category}.`);
    }
    if (sources.has(page.source)) {
      errors.push(`Duplicate guide source: ${page.source}.`);
    }
    if (slugs.has(page.slug)) {
      errors.push(`Duplicate guide slug: ${page.slug}.`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.slug)) {
      errors.push(`Unsafe guide slug: ${page.slug}.`);
    }
    if (!Array.isArray(page.tasks) || page.tasks.length === 0) {
      errors.push(`${page.source} must have at least one task label.`);
    }
    if (page.settings && !/^ui\/settings\.html(?:#[A-Za-z][\w-]*)?$/.test(page.settings.path)) {
      errors.push(`${page.source} has an unsafe settings path.`);
    }
    sources.add(page.source);
    slugs.add(page.slug);
  }

  if (new Set(USER_DOC_FILES).size !== USER_DOC_FILES.length) {
    errors.push('USER_DOC_FILES contains a duplicate path.');
  }

  return errors;
}

module.exports = {
  GUIDE_ASSETS,
  GUIDE_CATEGORIES,
  GUIDE_HUB_SOURCE,
  GUIDE_PAGES,
  GUIDE_REQUIRED_RELEASE_FILES,
  USER_DOC_FILES,
  validateGuideManifest
};
