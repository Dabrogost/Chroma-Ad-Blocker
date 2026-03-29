# Chroma Ad-Blocker

**Chroma Ad-Blocker** is a premium, high-performance browser extension built for Manifest V3 (MV3). It employs a sophisticated multi-layered strategy to bypass modern anti-adblock systems while maintaining a lightweight footprint. Chroma is 100% free and open-source, and always will be. It is highly recommeneded to disable all other ad-blockers while using Chroma.

## Key Features

- **Multi-Platform Ad Acceleration**: Automatically detects and accelerates video ads (up to 16x speed) on **YouTube** and **Prime Video**. This fulfills server-side impression requirements instantly without triggering ad-block detections.
- **Tier-1 Network Blocking (DNR)**: Utilizes a **10-Part ruleset system (300,000+ rules)** to block trackers, invasive analytics, and traditional banner ads at the browser engine level.
- **Global Protection Engine**:
    - **Push Suppression**: Proactively silences intrusive native notification prompts.
    - **Safety Exclusion Protocol**: Automatically bypasses critical infrastructure (Banks, Auth providers, .gov) to ensure no disruption to sensitive workflows.
- **Privacy-First Architecture**: Features a decentralized, token-gated communication pipeline. Your data never leaves your device; all stats and settings are stored locally.

---

## Architecture Overview

Chroma uses a decentralized architecture synchronized through `chrome.storage.local`. This ensures that configuration changes and statistics persist across the ephemeral Manifest V3 service worker lifecycle.

```mermaid
graph TD
    classDef sw fill:#a29bfe,color:#000,stroke:#6c5ce7,stroke-width:2px
    classDef storage fill:#0984e3,color:#fff,stroke:#0d47a1,stroke-width:2px
    classDef isolated fill:#00b894,color:#fff,stroke:#00695c,stroke-width:2px
    classDef main fill:#d63031,color:#fff,stroke:#b71c1c,stroke-width:2px
    classDef dnr fill:#2980b9,color:#fff,stroke:#1565c0,stroke-width:2px
    classDef dom fill:#e67e22,color:#fff,stroke:#e65100,stroke-width:2px
    classDef secure fill:#9b59b6,color:#fff,stroke:#8e44ad,stroke-width:2px
    classDef actor fill:#636e72,color:#fff,stroke:#2d3436,stroke-width:2px

    %% --- LAYER 0: ENTRANCE ---
    INTERNET["The Internet (Traffic, Ads, Scripts)"]:::actor

    %% --- LAYER 1: MAIN WORLD ---
    subgraph MW["Main World (Page Execution)"]
        MW_INT["interceptor.js<br/>(Pristine Cache + Safety Bypass)"]:::main
        BRIDGE["__CHROMA_INTERNAL__<br/>(Secure Bridge)"]:::secure
        CS_YT["yt_handler.js<br/>(YouTube)"]:::main
        CS_PV["prm_handler.js<br/>(Prime Video)"]:::main
    end

    %% --- LAYER 2: ISOLATED WORLD ---
    subgraph IW["Isolated World (Secure Relay)"]
        CS_PROT["protection.js<br/>(Push Suppression + Relay)"]:::isolated
        CS_GEN["content.js<br/>(Cosmetic Filter)"]:::isolated
    end

    %% --- LAYER 3: SERVICE WORKER CORE ---
    subgraph SW["Extension Core (Service Worker)"]
        VERIFY{{"Token Verification"}}:::secure
        BS["background.js<br/>(Main Router)"]:::sw
        AUTH["Session Token Store"]:::secure
    end

    %% --- LAYER 4: INFRASTRUCTURE ---
    subgraph System["Resource & Network Layer"]
        STORAGE[("chrome.storage.local")]:::storage
        DNR["10-Part DNR System<br/>(300,000 Rules)"]:::dnr
        YT_DOM["YouTube Player"]:::dom
        PV_DOM["Prime Player"]:::dom
    end

    %% --- LAYER 5: UI & OUTPUT ---
    POPUP["popup.js<br/>(UI/Stats)"]:::sw
    USER["The User (Cleaned & Accelerated UI)"]:::actor

    %% --- PIPELINE DEFINITION (0-21) ---
    
    %% INTERNET (Grey: 0, 1)
    INTERNET -- "Scripts" --> MW_INT
    INTERNET -- "Requests" --> DNR

    %% MAIN WORLD (Red: 2, 3, 4, 5)
    MW_INT <==>|"Token-Gated Handshake"| CS_PROT
    MW_INT --> BRIDGE
    CS_YT ==>|"Accelerate"| YT_DOM
    CS_PV ==>|"Accelerate"| PV_DOM

    %% SECURE (Purple: 6, 7, 8, 9)
    BRIDGE --> CS_YT
    BRIDGE --> CS_PV
    VERIFY -- "Valid" --> BS
    AUTH -- "Token" --> CS_PROT

    %% ISOLATED WORLD (Green: 10, 11, 12)
    CS_PROT -- "Relay + Token" --> VERIFY
    CS_GEN -.->|"Read Filter"| STORAGE
    CS_GEN ==>|"Visual Filter"| YT_DOM

    %% SERVICE WORKER CORE (Lavender: 13, 14, 15)
    BS -- "Lock" --> AUTH
    BS <-->|"Config Sync"| STORAGE
    BS -- "Dynamic Rules" --> DNR

    %% STORAGE (Blue: 16)
    STORAGE -.->|"Whitelist Bypass"| CS_PROT
    
    %% DNR (Blue: 17)
    DNR ---|"Network Shield"| USER

    %% PLAYERS (Orange: 18, 19)
    YT_DOM -- "Filtered Output" --> USER
    PV_DOM -- "Filtered Output" --> USER

    %% POPUP (Lavender: 20, 21)
    POPUP ---|"Stats Sync"| STORAGE
    POPUP -- "Final Statistics" --> USER

    %% --- LOGIC TRACING (LINK STYLES) ---
    %% Internet/User Origin: Grey
    linkStyle 0,1 stroke:#636e72,stroke-width:2px;
    %% Main World Origin: Red
    linkStyle 2,3,4,5 stroke:#d63031,stroke-width:2px;
    %% Secure Layer Origin: Purple
    linkStyle 6,7,8,9 stroke:#9b59b6,stroke-width:2px;
    %% Isolated World Origin: Green
    linkStyle 10,11,12 stroke:#00b894,stroke-width:2px;
    %% SW Core Origin: Lavender
    linkStyle 13,14,15,20,21 stroke:#a29bfe,stroke-width:2px;
    %% System / Storage Origin: Blue
    linkStyle 16,17 stroke:#0984e3,stroke-width:2px;
    %% DOM Player Origin: Orange
    linkStyle 18,19 stroke:#e67e22,stroke-width:2px;

    %% --- HIDE SUBGRAPH BOXES ---
    style MW fill:none,stroke:none
    style IW fill:none,stroke:none
    style SW fill:none,stroke:none
    style System fill:none,stroke:none
```










```








---

## System Layers

### Layer 1: Ad Acceleration (`yt_handler.js`, `prm_handler.js`)
The ultimate defense against server-side ad detection. Instead of blocking the video stream (which triggers warnings), Chroma accelerates ads to 16x speed and mutes them.

### Layer 2: Network-Level Blocking (`rules/`, `background.js`)
Powered by Chrome’s **Declarative Net Request (DNR)** API. Chroma partitions over **300,000 rules** into 10 manageable files to ensure high performance and reliability. The Service Worker handles rule state and periodically harvests block statistics.

### Layer 3: Cosmetic & Warning Suppression (`content.js`, `utils/selectors.js`)
Uses a `MutationObserver` and dynamic CSS injection to hide ad slots, remove "Ad blockers are not allowed" modals, and clean up the interface (removing Shorts, Merch, and Offers).

### Layer 4: Universal Protection (`protection.js`, `interceptor.js`)
A proactive approach to blocking intrusive push notification requests globally. The `interceptor.js` runs in the **Main World** to shadow browser APIs, while `protection.js` relays events to the background via a **Secure Pipeline** for enforcement.

---

## Security Hardening

Chroma implements several advanced security measures to ensure integrity and prevent bypass by malicious scripts:

- **Immutable API Bridge**: Chroma exposes internal utilities (like `calculateChromaColor`) via a locked `__CHROMA_INTERNAL__` object. This bridge is protected using `Object.defineProperty` with `writable: false` and `configurable: false`, preventing host pages from hijacking or redefining extension-owned logic.
- **Pristine API Caching**: `interceptor.js` captures and freezes native browser APIs (like `querySelector`, `setTimeout`, and `MutationObserver`) at `document_start`. This ensures that even if a site attempts prototype pollution or API tampering, the extension continues to operate using its own "known good" references.
- **Strict Message Whitelisting**: The internal messaging bridge only permits a narrow list of authorized actions (e.g., `SUSPICIOUS_ACTIVITY`). The Background Service Worker rejects any request that lacks a valid per-tab session token or attempts to execute an unauthorized action.
- **Origin Authentication**: The Background Service Worker strictly validates the origin and sender context of all incoming messages, rejecting any sensitive configuration or statistic requests from outside the extension's own verified context.

---

## Quick Start

1. Download the ZIP from GitHub and extract it (or clone the repo).
2. Open `chrome://extensions` in Chrome.
3. Toggle on **Developer mode** (top-right corner).
4. Click **"Load unpacked"** &rarr; select the `extension/` folder (inside the extracted repo).
5. Done &mdash; Chroma is active on all tabs. Settings can be managed via the popup UI.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Global switch for all features. | `true` |
| `networkBlocking` | Enables DNR rulesets (300k rules). | `true` |
| `acceleration` | Enables high-speed ad playback (YT/Prm). | `true` |
| `cosmetic` | Enables hiding ad placeholders via CSS. | `true` |
| `hideShorts` | Removes Shorts from feed. | `false` |
| `hideMerch` | Removes Merchandise panels. | `true` |
| `hideOffers` | Removes Movie/TV offers. | `true` |
| `suppressWarnings` | Removes anti-adblock modals/locks. | `true` |
| `blockPushNotifications` | Blocks web notification requests. | `true` |
| `whitelist` | Toggles blocking for the current active site. | `false` |

---

## AI Usage & Quality Assurance Disclosure

Portions of this codebase, including initial logic structures and documentation, were developed with the assistance of agentic AI coding assistants. To ensure project integrity, every AI-assisted component has been manually audited, refactored, and verified to meet strict security and performance standards. This collaborative approach combines the efficiency of advanced tooling with focused oversight and robust test coverage.

---

## Legal Disclaimers

**Trademark Disclaimer:** YouTube is a trademark of Google LLC. Amazon Prime Video is a trademark of Amazon.com, Inc. Chroma Ad-Blocker is an independent project and is NOT affiliated with, endorsed by, or sponsored by Google LLC, YouTube, Amazon.com, Inc., or any other third-party platform.

**Usage Warning:** Using ad-blockers or ad-acceleration tools may violate the Terms of Service of various platforms. By using Chroma, you acknowledge and assume all risks associated with potential account restrictions or enforcement actions.

---

## Security Policy

For information on how to report security vulnerabilities, please see our [Security Policy](SECURITY.md).

---

## Support the Project

Chroma is a solo project dedicated to restoring the web to its fast, private, and uninterrupted roots. It is 100% free for everyone, forever. If this tool has made your daily browsing a little more colorful, consider supporting this mission.

  <a href="https://github.com/Dabrogost/Chroma-Ad-Blocker">GitHub Repository</a>

<br/>

<div align="center">
  <a href="https://buymeacoffee.com/dabrogost">
    <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee">
  </a>
</div>

<p align="right">
  <sub>Copyright 2026 Dabrogost</sub>
</p>
