# Chroma Ad-Blocker

**Chroma Ad-Blocker** is a premium, high-performance browser extension built for Manifest V3 (MV3). It employs a sophisticated multi-layered strategy to bypass modern anti-adblock systems while maintaining a lightweight footprint. It is highly recommeneded to disable all other ad-blockers while using Chroma.

## Key Features

- **Multi-Platform Ad Acceleration**: Automatically detects and accelerates ads (up to 16x speed) on **YT** and **Prm**. This fulfills server-side impression requirements instantly without triggering ad-block detections.
- **Massive Network Blocking (DNR)**: Utilizes **300,000 optimized rules** across 10 rulesets to block trackers, invasive analytics, and traditional banner ads at the browser level.
- **Cosmetic Filtering & Layout Cleanup**: Proactively removes ad placeholders, sidebars, and empty slots.
- **YT Power Tools**:
    - **Hide Shorts**: Clean up your feed by removing Shorts shelves and menu entries.
    - **Hide Merch & Offers**: Suppress intrusive shopping panels and rental/buy offers.
    - **Anti-Adblock Suppression**: Automatically deletes enforcement modals (e.g., "Ad blockers are not allowed") and restores page functionality.
- **Global Privacy Protection**:
    - **Pop-under Blocker**: Intercepts and closes suspicious windows opened without direct user intent.
    - **Push Suppression**: Automatically silences intrusive "Show notifications" prompts from websites.
- **Privacy-First Architecture**: Your data never leaves your device. All stats and settings are stored locally.

---

## Architecture Overview

Chroma uses a decentralized architecture synchronized through `chrome.storage.local`. This ensures that configuration changes and statistics persist across the ephemeral Manifest V3 service worker lifecycle.

```mermaid
graph TD
    classDef sw fill:#2d3436,color:#fff,stroke:#636e72,stroke-width:2px
    classDef storage fill:#0984e3,color:#fff,stroke:#74b9ff,stroke-width:2px
    classDef isolated fill:#00b894,color:#fff,stroke:#55efc4,stroke-width:2px
    classDef main fill:#d63031,color:#fff,stroke:#ff7675,stroke-width:2px
    classDef dnr fill:#6c5ce7,color:#fff,stroke:#a29bfe,stroke-width:2px
    classDef dom fill:#f1c40f,color:#000,stroke:#f39c12,stroke-width:2px
    classDef secure fill:#ffeaa7,color:#000,stroke:#fab1a0,stroke-dasharray: 5 5

    subgraph SW ["Extension Core (Service Worker)"]
        BS["background.js<br/>(Main Logic & Router)"]:::sw
        AUTH["Origin Auth &<br/>Session Token Store"]:::secure
    end

    subgraph ST ["Central Hub"]
        STORAGE[("chrome.storage.local")]:::storage
    end

    subgraph GR ["Global Protection Layer (Secure Pipeline)"]
        subgraph MW ["Main World Execution"]
            MW_INT["interceptor.js<br/>(Pristine API Cache)"]:::main
        end
        subgraph IW ["Isolated World Relay"]
            CS_PROT["protection.js<br/>(Secure Handshake)"]:::isolated
        end
        MW_INT <==>|"Secure MessagePort Handshake"| CS_PROT
    end

    subgraph SP ["Site-Specific Accelerators"]
        CS_YT["yt_handler.js<br/>(Shadow DOM)"]:::isolated
        CS_PV["prm_handler.js<br/>(Shadow DOM)"]:::isolated
        CS_GEN["content.js<br/>(Cosmetic Filter)"]:::isolated
    end

    subgraph DN ["Network Blocking (DNR)"]
        DNR["Declarative Net Request<br/>(300k Rules)"]:::dnr
    end

    %% Logic Flow
    MW_INT -- "Interception" --> CS_PROT
    CS_PROT -- "Relay (Verified Token)" --> BS
    
    CS_YT -- "Stats" --> BS
    CS_PV -- "Stats" --> BS
    
    BS <-->|"Sync State"| STORAGE
    BS -- "Generate Token" --> AUTH
    AUTH -- "Auth Token" --> CS_PROT
    
    CS_YT -.->|"Read Config"| STORAGE
    CS_PV -.->|"Read Config"| STORAGE
    CS_GEN -.->|"Read Config"| STORAGE
    CS_PROT -.->|"Read Config/Selectors"| STORAGE

    BS -- "Harvest Matches" --> DNR

    %% Execution
    CS_YT ==>|"Accelerate"| DOM_YT["YT Shadow DOM"]:::dom
    CS_PV ==>|"Accelerate"| DOM_PV["Prm Shadow DOM"]:::dom
    CS_GEN ==>|"Hide/Remove"| DOM_YT
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
A dual-layer approach to blocking pop-unders and push notifications globally. The `interceptor.js` runs in the **Main World** to shadow browser APIs, while `protection.js` relays events to the background via a **Secure Pipeline** for enforcement.

---

## Security Hardening

Chroma implements several advanced security measures to ensure integrity and prevent bypass by malicious scripts:

- **Secure Communication Pipeline**: Instead of standard `window.postMessage`, Chroma establishes a dedicated `MessageChannel` (secure port) between the Main World and Isolated World. This prevents host-page scripts from sniffing or spoofing sensitive control signals.
- **Per-Tab Session Tokens**: Every tab is assigned a unique, 16-byte random session token generated by the Background Service Worker. All signals from the Main World must include this verified token to be processed.
- **Pristine API Caching**: `interceptor.js` captures native browser APIs (like `window.open` and `fetch`) on Line 1 of execution. This mitigates race conditions where malicious site scripts might try to override these APIs before the extension can.
- **API Lockdown**: Once intercepted, sensitive browser APIs are frozen using `Object.defineProperty` with `writable: false` to prevent the host page from "re-clobbering" the extension's protection layers.
- **Origin Authentication**: The Background Service Worker strictly validates the origin of all incoming messages, rejecting any sensitive configuration or statistic requests from outside the extension's own internal context.

---

## Quick Start

1. Clone the repository or download the ZIP.
2. Navigate to `chrome://extensions/` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the extension folder.
5. The extension is now active on all tabs. Settings can be managed via the popup UI.

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
| `blockPopUnders` | Intercepts unauthorized new windows. | `true` |
| `blockPushNotifications` | Blocks web notification requests. | `true` |
| `whitelist` | Toggles blocking for the current active site. | `false` |

---

## AI Usage & Quality Assurance Disclosure

Portions of this codebase, including initial logic structures and documentation, were developed with the assistance of agentic AI coding assistants. To ensure project integrity, every AI-assisted component has been manually audited, refactored, and verified to meet strict security and performance standards. This collaborative approach combines the efficiency of advanced tooling with focused oversight and robust test coverage.

---

## Support the Project

Chroma is a solo project dedicated to restoring the web to its fast, private, and uninterrupted roots. If this tool has made your daily browsing a little more colorful, consider supporting this mission.

<div align="center">
  <a href="https://github.com/Dabrogost/Chroma-Ad-Blocker">GitHub Repository</a>
</div>

<br/>

<div align="center">
  <a href="https://buymeacoffee.com/dabrogost">
    <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee">
  </a>
</div>

<p align="right">
  <sub>&copy; 2026 Dabrogost</sub>
</p>
