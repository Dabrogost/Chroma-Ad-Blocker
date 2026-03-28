---
layout: default
title: Home
layout-class: layout-home
mermaid: true
description: Multi-layered ad blocking built for Manifest V3. Block ads, accelerate them away, and protect your privacy — all locally on your device.
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
    and filter ads&nbsp;&mdash; all locally on your device, zero data collected.
    <br/><strong>Always 100% free and open-source.</strong>
  </p>

  <div class="hero__ctas">
    <a
      href="https://github.com/Dabrogost/YT-Chroma"
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
      Privacy Policy
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
        Ads play at 16&times; speed with audio muted. Fulfills impression requirements
        server-side without triggering detection&nbsp;&mdash; the cleanest bypass available.
      </p>
      <span class="card__tag">YT &middot; APV</span>
    </div>

    <!-- Card 2: Network Blocking -->
    <div class="card card--magenta fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <h3 class="card__title">Network Blocking</h3>
      <p class="card__desc">
        300,000 declarative net request rules block tracker pings, analytics
        beacons, and banner ads at the browser level before they ever load.
      </p>
      <span class="card__tag">300k+ DNR Rules</span>
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

    <!-- Card 4: YT Power Tools -->
    <div class="card card--blue fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
      <h3 class="card__title">YT Power Tools</h3>
      <p class="card__desc">
        Hide Shorts shelves, remove merchandise carousels, suppress movie rental
        offers, and silently delete anti-adblock enforcement modals as they appear.
      </p>
      <span class="card__tag">Shorts &middot; Merch &middot; Offers</span>
    </div>

    <!-- Card 5: Pop-Under Blocker -->
    <div class="card card--bblue fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
        <line x1="8.5" y1="7.5" x2="15.5" y2="14.5"/>
        <line x1="15.5" y1="7.5" x2="8.5" y2="14.5"/>
      </svg>
      <h3 class="card__title">Pop-Under Blocker</h3>
      <p class="card__desc">
        A secure MessageChannel pipeline intercepts <code>window.open</code> calls,
        validates user intent via gesture timing, and closes suspicious tabs before
        they render.
      </p>
      <span class="card__tag">Gesture Detection</span>
    </div>

    <!-- Card 6: Push Suppression -->
    <div class="card card--cyan fade-up">
      <svg class="card__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
      <h3 class="card__title">Push Suppression</h3>
      <p class="card__desc">
        Overrides the Notification API, PushManager, and ServiceWorker registration
        in the Main World to silently deny intrusive permission requests globally.
      </p>
      <span class="card__tag">Notification API</span>
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
        A decentralized, token-verified pipeline synchronized through
        <code style="background:rgba(153,0,255,.12);color:#cc77ff;padding:2px 7px;border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:12px;border:1px solid rgba(153,0,255,.22)">chrome.storage.local</code>
        — resilient against the ephemeral MV3 service worker lifecycle.
      </p>
    </div>

    <div class="mermaid">
graph TD
    classDef sw fill:#1a0a35,color:#ede8ff,stroke:#9900ff,stroke-width:2px
    classDef storage fill:#0a2040,color:#ede8ff,stroke:#00aaff,stroke-width:2px
    classDef isolated fill:#0a2a1a,color:#ede8ff,stroke:#00ffcc,stroke-width:2px
    classDef main fill:#2a0a10,color:#ede8ff,stroke:#ff0055,stroke-width:2px
    classDef dnr fill:#1a1040,color:#ede8ff,stroke:#0088ff,stroke-width:2px
    classDef dom fill:#1a1500,color:#ede8ff,stroke:#ff9900,stroke-width:2px
    classDef secure fill:#1a1205,color:#ede8ff,stroke:#cc77ff,stroke-width:2px
    classDef actor fill:#161b22,color:#ede8ff,stroke:#8b949e,stroke-width:2px
    INTERNET["The Internet (Traffic, Ads, Scripts)"]:::actor
    subgraph MW["Main World (Page Execution)"]
        MW_INT["interceptor.js<br/>(Pristine Cache + Safety Bypass)"]:::main
        BRIDGE["__CHROMA_INTERNAL__<br/>(Secure Bridge)"]:::secure
        CS_YT["yt_handler.js<br/>(YouTube)"]:::main
        CS_PV["prm_handler.js<br/>(Prime Video)"]:::main
    end
    subgraph IW["Isolated World (Secure Relay)"]
        CS_PROT["protection.js<br/>(Gesture Tracking + Relay)"]:::isolated
        CS_GEN["content.js<br/>(Cosmetic Filter)"]:::isolated
    end
    subgraph SW["Extension Core (Service Worker)"]
        VERIFY{{Token Verification}}:::secure
        BS["background.js<br/>(Main Router)"]:::sw
        AUTH["Session Token Store"]:::secure
    end
    subgraph System["Resource & Network Layer"]
        STORAGE[(chrome.storage.local)]:::storage
        DNR["10-Part DNR System<br/>(300,000 Rules)"]:::dnr
        YT_DOM["YouTube Player"]:::dom
        PV_DOM["Prime Player"]:::dom
    end
    POPUP["popup.js<br/>(UI/Stats)"]:::sw
    USER["The User (Cleaned & Accelerated UI)"]:::actor
    INTERNET--"Scripts"-->MW_INT
    INTERNET--"Requests"-->DNR
    MW_INT<==>|"Token-Gated Handshake"|CS_PROT
    MW_INT-->BRIDGE
    CS_YT==>|"Accelerate"|YT_DOM
    CS_PV==>|"Accelerate"|PV_DOM
    BRIDGE-->CS_YT
    BRIDGE-->CS_PV
    VERIFY--"Valid"-->BS
    AUTH--"Token"-->CS_PROT
    CS_PROT--"Relay + Token"-->VERIFY
    CS_GEN-.->|"Read Filter"|STORAGE
    CS_GEN==>|"Visual Filter"|YT_DOM
    BS--"Lock"-->AUTH
    BS<-->|"Config Sync"|STORAGE
    BS--"Dynamic Rules"-->DNR
    STORAGE-.->|"Whitelist Bypass"|CS_PROT
    DNR---|"Network Shield"|USER
    YT_DOM--"Filtered Output"-->USER
    PV_DOM--"Filtered Output"-->USER
    POPUP---|"Stats Sync"|STORAGE
    POPUP--"Final Statistics"-->USER
    linkStyle 0,1 stroke:#8b949e,stroke-width:2px;
    linkStyle 2,3,4,5 stroke:#ff0055,stroke-width:2px;
    linkStyle 6,7,8,9 stroke:#cc77ff,stroke-width:2px;
    linkStyle 10,11,12 stroke:#00ffcc,stroke-width:2px;
    linkStyle 13,14,15,20,21 stroke:#9900ff,stroke-width:2px;
    linkStyle 16 stroke:#00aaff,stroke-width:2px;
    linkStyle 17 stroke:#0088ff,stroke-width:2px;
    linkStyle 18,19 stroke:#ff9900,stroke-width:2px;
    style MW fill:none,stroke:none
    style IW fill:none,stroke:none
    style SW fill:none,stroke:none
    style System fill:none,stroke:none
    </div>
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
