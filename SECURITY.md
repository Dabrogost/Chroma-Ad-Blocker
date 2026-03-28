---
layout: default
title: Security Policy
layout-class: layout-prose
description: Chroma Ad-Blocker security policy — reporting vulnerabilities and version support.
---

# Security Policy

<p class="section__sub" style="margin-top: -24px; margin-bottom: 48px;">
  We take the security of Chroma Ad-Blocker seriously. If you believe you have 
  found a security vulnerability, please follow the disclosure process below.
</p>

<div class="cards-grid" style="grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; margin-bottom: 64px;">

  <!-- Card 1: Supported Versions -->
  <div class="card card--purple fade-up">
    <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="M12 8v4"/>
      <path d="M12 16h.01"/>
    </svg>
    <h3 class="card__title">Supported Versions</h3>
    <p class="card__desc">
      Currently, only the latest version of Chroma Ad-Blocker (the <code>master</code> branch) 
      is actively supported with security updates.
    </p>
    <span class="card__tag">Branch: master</span>
  </div>

  <!-- Card 2: Reporting a Vulnerability -->
  <div class="card card--red fade-up">
    <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
    <h3 class="card__title">Reporting a Vulnerability</h3>
    <p class="card__desc">
      If you discover a vulnerability, please send an email to 
      <strong>dabrogost@gmail.com</strong>. Include a description, reproduction steps, 
      and potential impact.
    </p>
    <span class="card__tag">Private Disclosure</span>
  </div>

</div>

## Disclosure Process

We value the work of developers and security researchers. Once a report is received:

1.  **Acknowledgment**: We will acknowledge your report as quickly as possible.
2.  **Investigation**: We will investigate the issue and determine the potential impact.
3.  **Resolution**: We will work on a fix and release an update via the GitHub repository.

> [!IMPORTANT]
> Please do not open public issues for security vulnerabilities. We ask that you follow 
> responsible disclosure practices to protect all users of the extension.
