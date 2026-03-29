---
layout: default
title: Home
layout-class: layout-home
mermaid: true
description: Multi-layered ad blocking built for Manifest V3. Works on Windows, macOS, and Linux. Block ads, accelerate them away, and protect your privacy — all locally on your device.
---

<!-- ═══════════════════════════════════════ HERO ════════════════════════════════════════ -->
<section class="hero">
  <div class="hero__logo-wrap">
    <div class="hero__ring hero__ring--outer"></div>
    <div class="hero__ring hero__ring--inner"></div>
    <img
      src="{{ '/icons/icon128.png' | relative_url }}"
      alt="Chroma Ad-Blocker"
      class="hero__logo"
      width="72"
      height="72"
    />
  </div>

  <p class="hero__eyebrow">Manifest V3 &middot; Browser Extension</p>

  <h1 class="hero__title">Chroma<br/>Ad&#8209;Blocker</h1>

  <p class="hero__tagline">
    Multi-layered protection built for the modern web. Accelerate, block,
    and filter ads &mdash; all locally on your device, zero data collected.
    <br/><strong>Always free, open-source, and compatible with Windows, Mac, and Linux.</strong>
  </p>

  <div class="hero__ctas">
    <a
      href="https://github.com/Dabrogost/Chroma-Ad-Blocker"
      target="_blank"
      rel="noopener noreferrer"
      class="btn-primary"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
      </svg>
      View on GitHub
    </a>
    <a
      href="https://buymeacoffee.com/dabrogost"
      target="_blank"
      rel="noopener noreferrer"
      class="btn-ghost"
    >
      Support Development
    </a>
    <a href="{{ '/PRIVACY_POLICY/' | relative_url }}" class="btn-ghost">
      Privacy
    </a>
    <a href="{{ '/ToS/' | relative_url }}" class="btn-ghost">
      Terms
    </a>
  </div>

  <div class="hero__scroll-cue" aria-hidden="true">
    <div class="hero__scroll-chevron"></div>
    <span>scroll</span>
  </div>
</section>

<!-- ═══════════════════════════════════ FEATURE CARDS ══════════════════════════════════ -->
<section class="section">
  <p class="section__eyebrow fade-up">Protection Layers</p>
  <h2 class="section__title fade-up">Built to Outlast<br/>Every Ad System</h2>
  <p class="section__sub fade-up">
    Six independent layers of protection, each targeting a different attack vector.
    Together they handle anything ad networks throw at your browser.
  </p>

  <div class="cards-grid">

    <!-- Card 1: Ad Acceleration -->
    <div class="card card--red fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <h3 class="card__title">Ad Acceleration</h3>
      <p class="card__desc">
        Automatically identifies and accelerates video ads to 16x speed with audio muted. 
        Maintains server-side impression integrity without interrupting the user experience.
      </p>
      <span class="card__tag">YouTube &middot; Prime Video</span>
    </div>

    <!-- Card 2: Network Blocking -->
    <div class="card card--magenta fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <h3 class="card__title">Network Blocking</h3>
      <p class="card__desc">
        A multi-part Declarative Net Request (DNR) system blocks tracker pings, analytics 
        beacons, and traditional banner ads at the browser level before they load.
      </p>
      <span class="card__tag">Multi-part DNR ruleset</span>
    </div>

    <!-- Card 3: Cosmetic Filtering -->
    <div class="card card--purple fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
      <h3 class="card__title">Cosmetic Filtering</h3>
      <p class="card__desc">
        MutationObserver-driven CSS injection surgically removes ad placeholders, 
        empty slots, and layout artifacts in real time as pages load and navigate.
      </p>
      <span class="card__tag">MutationObserver</span>
    </div>

    <!-- Card 4: Global Protection -->
    <div class="card card--blue fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
      <h3 class="card__title">Global Components</h3>
      <p class="card__desc">
        Hide non-video components like Shorts, merchandise carousels, and 
        rental offers, while removing unsolicited overlay dialogs that restrict content access based on browser configuration.
      </p>
      <span class="card__tag">Shorts &middot; Merch &middot; Offers</span>
    </div>

    <!-- Card 5: Push Suppression -->
    <div class="card card--cyan fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
      <h3 class="card__title">Push Suppression</h3>
      <p class="card__desc">
        Overrides the Notification API and PushManager registration in the Main World 
        to silently deny intrusive permission requests globally.
      </p>
      <span class="card__tag">Notification API</span>
    </div>

    <!-- Card 6: Hardened Security -->
    <div class="card card--bblue fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <h3 class="card__title">Hardened Security</h3>
      <p class="card__desc">
        A session-based token handshake ensures secure communication between 
        execution worlds, while local-only processing keeps your data private.
      </p>
      <span class="card__tag">Secure Handshake &middot; Local-Only</span>
    </div>

  </div>
</section>

<!-- ══════════════════════════════════ ARCHITECTURE ════════════════════════════════════ -->
<section class="arch-section">
  <div class="arch-card fade-up">
    <div class="arch-header">
      <p class="section__eyebrow">Architecture</p>
      <h2 class="section__title">How Chroma Works</h2>
      <p class="section__sub">
        Chroma uses a privacy-first, multi-layered security engine to identify and 
        neutralize ads before they reach your screen. By processing everything locally
        on your device, your data stays 100% private while you enjoy a cleaner, faster web.
      </p>
    </div>

    <div class="mermaid">
graph TD
    classDef actor fill:#1a1040,color:#ede8ff,stroke:#8b949e,stroke-width:2px
    classDef engine fill:#1a1040,color:#ede8ff,stroke:#01579b,stroke-width:2px
    classDef action fill:#1a0a35,color:#ede8ff,stroke:#f57f17,stroke-width:2px

    INTERNET["The Internet (Ads & Content)"]:::actor

    subgraph CHROMA["Chroma Ad-Blocker Engine"]
        NETWORK["Network Shield (Blocks Trackers & Banners)"]:::action
        VIDEO["Video Accelerator (Speeds Through Video Ads)"]:::action
        CONTENT["Content Cleaner (Removes Overlays & Symbols)"]:::action
    end

    USER["The User (Cleaned Experience)"]:::actor

    INTERNET --> NETWORK
    INTERNET --> VIDEO
    INTERNET --> CONTENT

    NETWORK --> USER
    VIDEO --> USER
    CONTENT --> USER

    style CHROMA fill:none,stroke:none
    </div>
  </div>
</section>

<!-- ══════════════════════════════════ QUICK START ═════════════════════════════════════ -->
<section class="qs-section">
  <p class="section__eyebrow fade-up">Quick Start</p>
  <h2 class="section__title fade-up">Up and Running<br/>in Under a Minute</h2>

  <div class="qs-steps fade-up">
    <div class="qs-line"></div>

    <div class="qs-step">
      <div class="qs-step__num">1</div>
      <p class="qs-step__label">Download the ZIP from GitHub and extract it (or clone the repo)</p>
    </div>

    <div class="qs-step">
      <div class="qs-step__num">2</div>
      <p class="qs-step__label">Open <code style="font-size:11px">chrome://extensions</code> in Chrome</p>
    </div>

    <div class="qs-step">
      <div class="qs-step__num">3</div>
      <p class="qs-step__label">Toggle on Developer Mode (top-right corner)</p>
    </div>

    <div class="qs-step">
      <div class="qs-step__num">4</div>
      <p class="qs-step__label">Click "Load unpacked" &rarr; select the <code style="font-size:11px">extension/</code> folder (inside the extracted repo)</p>
    </div>

    <div class="qs-step">
      <div class="qs-step__num">5</div>
      <p class="qs-step__label">Done &mdash; Chroma is active on all tabs</p>
    </div>
  </div>
</section>
<!-- ════════════════════════════════════ SUPPORT ═══════════════════════════════════════ -->
<section class="support-section fade-up">
  <h2 class="section__title">Support the Project</h2>
  <p class="section__sub">
    Chroma is 100% free, open-source, and always will be. It is built and 
    maintained by a single developer. If it has improved your
    web experience, consider supporting the work with a coffee.
  </p>
  <a
    href="https://buymeacoffee.com/dabrogost"
    target="_blank"
    rel="noopener noreferrer"
    class="btn-bmc"
  >
    Buy me a coffee
  </a>
</section>
