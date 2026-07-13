# Media Proxy Router

Chroma includes a built-in split-tunnel proxy router that allows you to route traffic for specific media domains through a proxy server while keeping the rest of your browser traffic on your direct, local connection.

It is designed for media-site routing: sending supported services through proxy regions that reduce ad serving, or through country-specific routes for region-specific media delivery. This operates entirely within the browser via dynamic Proxy Auto-Configuration scripts, so it does not require a system-level VPN installation.

<div align="center">
  <img src="assets/docs-settings-proxy-router.png" alt="Chroma media proxy router settings" width="760">
</div>

## How This Differs From FoxyProxy

Chroma's proxy router is not intended to replace a full general-purpose proxy manager such as FoxyProxy. FoxyProxy is designed around proxy profiles, URL patterns, tab-level routing, quick switching, import/export workflows, and broad user-defined proxy management.

Chroma's router is narrower by design. It exists as one layer of Chroma's larger local protection stack: DNR network blocking, scriptlets, cosmetic filtering, media handling, local event tracking, and optional browser-level routing all work together. The proxy layer is focused on split-tunneling selected media domains through user-provided proxies while keeping unrelated browser traffic direct, or optionally sending unmatched browser traffic through a Global Fallback proxy.

The main difference is that Chroma is media-aware. When a supported streaming or media service is routed, Chroma can automatically include related CDN and delivery domains so the service UI and media stream are less likely to split across different IP paths. For example, adding `youtube.com` can also route related YouTube delivery domains such as `googlevideo.com`, `ytimg.com`, and `youtube-nocookie.com`.

Chroma's design principle is:

> DNR is the policy gate. PAC is the transport selector.

Network filtering decides what should be blocked or allowed by the browser's DNR engine. Proxy routing decides whether browser traffic that proceeds through Chrome's network stack should go direct or through a selected proxy.

| Feature | Chroma Proxy Router | General Proxy Manager |
|---|---|---|
| Primary purpose | Media-aware split tunneling for ad-reducing or country-specific media routes inside Chroma's protection stack | Full proxy profile and rule management |
| Routing model | Domain-specific rules, Smart-Link CDN expansion, optional Global Fallback | Proxy profiles, URL patterns, tab rules, PAC URLs, quick switching |
| Scope | Browser-level routing for selected traffic | General-purpose proxy control |
| Ad-block integration | Works alongside Chroma's DNR, scriptlet, cosmetic, and media layers | Usually separate from ad blocking |
| Best use case | Route a service like YouTube, Netflix, Prime Video, or Twitch through a chosen media region without routing everything | Manage many proxies and complex user-defined routing rules |

Use FoxyProxy when you want a dedicated proxy manager. Use Chroma's proxy router when you want routing to work as part of Chroma's ad-blocking, media, and privacy stack.

## Supported Protocols

Chroma supports `HTTP`, `HTTPS`, `SOCKS4`, and `SOCKS5` proxies. Choose the protocol from the proxy setup dropdown, then enter the proxy host without a protocol prefix.

SOCKS4/SOCKS5 proxies are supported only when they do not require username/password authentication. Chrome extensions can provide credentials for HTTP/HTTPS proxy authentication challenges, but Chrome does not expose SOCKS username/password authentication to extensions through the proxy/PAC flow.

For authenticated SOCKS providers, use provider-side IP allowlisting if available, or choose an HTTP/HTTPS proxy endpoint instead.

This limitation is specific to browser-level proxy routing in Chromium. It does not mean authenticated SOCKS5 is impossible everywhere. Apps that implement their own SOCKS connection can accept SOCKS credentials directly. For example, [NordVPN documents SOCKS5 setup in qBittorrent](https://support.nordvpn.com/hc/en-us/articles/20195967385745-NordVPN-proxy-setup-for-qBittorrent) with a SOCKS5 host, port `1080`, and service username/password. That works because qBittorrent owns the SOCKS connection; Chroma only controls Chrome's PAC/proxy route.

## Security

Your proxy credentials, username and password, are stored locally in an obfuscated form using a bundled extension key. They are decoded in memory only for a genuine proxy-authentication challenge. Chroma requires the exact normalized host, port, and HTTP/HTTPS proxy type to match the route currently effective in Chrome. Disabled, deleted, stale, unrouted, master-paused, test-inactive, or externally controlled proxy records receive no credentials. Authentication attempts are bounded per request to prevent challenge loops.

This can reduce casual readability in extension storage, but it is not strong encryption and is not a substitute for operating-system or browser-profile security.

## Connection Verification

The Chroma popup includes a **Connection Verification** system. When you request a test, Chroma first makes the selected test route its desired Chrome route and verifies that Chroma actually controls the matching PAC state. If another extension or browser policy owns proxy settings, the test is reported as unavailable/degraded rather than healthy. A successful test displays the detected proxied IP address when available and is cached briefly for that exact proxy connection definition.

## Global Proxy Fallback

In addition to domain-specific routing, Chroma supports a **Global Fallback** mode. Click the **GLOBAL** button on a proxy card to select that proxy as the fallback for browser traffic that does not match a domain-specific rule.

This is browser-level proxy routing, not a system VPN, while still allowing you to send specific traffic, such as YouTube, to a different proxy server simultaneously.

The main switch on each proxy card is a per-proxy enabled/disabled control:

- **Switch ON**: The proxy can route its enabled domain rules and can act as the selected global fallback if its **GLOBAL** button is active.
- **Switch OFF**: The proxy routes nothing while disabled. Its domain rows are kept, and if it was selected as **GLOBAL**, that global selection is preserved but inactive until the switch is turned back on.
- **GLOBAL button**: Selects or clears the global fallback independently from the main switch. The active **GLOBAL** button is highlighted. The selected global card hides its domain add/list controls while it is global; non-global proxy cards keep their domain controls visible.

### Master Protection Lifecycle

The global Chroma master switch is authoritative over every proxy route. Master off releases `chrome.proxy.settings` and pauses domain-specific, global-fallback, and test routing while preserving proxy records, enabled flags, domains, and the selected global ID. Master on rebuilds the requested PAC route from that stored intent.

Chrome allows only one extension or policy controller to own proxy settings at a time. If another controller wins, Chroma separates **requested** from **effective** routing, withholds credentials, reports the conflict in Health, and removes dormant Chroma PAC state so an obsolete route cannot reactivate later. When Chrome reports that control is available again, Chroma automatically reconciles the latest stored intent.

## Chrome Browser Services Bypass

When Global Proxy Fallback is enabled, Chroma can optionally bypass Chrome-owned browser service traffic so Chrome's own infrastructure can still connect directly. The **Bypass Chrome Browser Services** toggle is enabled by default so the extension does not appear to break Chrome functionality when Global Proxy is enabled.

Recommended mode lets Chrome-owned services connect directly while Global Proxy is enabled, helping browser-managed features such as updates, sign-in, and optional browser services keep working. Turning this off is stricter, but may cause Chrome-owned features to fail while Global Proxy Fallback is active.

## WebRTC Leak Protection

WebRTC Leak Protection helps prevent WebRTC/STUN traffic from bypassing proxy routing. WebRTC can discover network candidates through paths that are separate from normal browser page requests, so a page may be able to see a WebRTC public IP even while regular traffic is routed through Chroma's proxy fallback.

Chroma controls Chrome's native WebRTC IP handling policy to reduce that bypass risk.

Modes:

- **Auto**: Applies strict WebRTC protection when Global Proxy Fallback is enabled and configured, and releases the browser setting when it no longer applies.
- **Balanced**: Limits WebRTC to the default public interface only.
- **Strict**: Disables non-proxied UDP. This offers the strongest protection but may affect browser calls or video chat quality.
- **Off**: Releases Chroma's WebRTC routing control.

Auto, Balanced, and Strict describe stored intent only while master protection is enabled. Master off releases Chroma's WebRTC setting without erasing the selected mode; master on restores it. If another extension or policy controls the setting, Health reports the request as degraded and Chroma retries automatically when control is released.

## Dynamic Routing Status

Proxy cards summarize saved route intent and the latest connection-test result:

- **GLOBAL PROXY ACTIVE**: The server is handling all browser traffic.
- **ROUTING [X] DOMAINS**: The server is only handling the specific domains you have listed.
- **CONNECTED**: The server is ready but has no current routing assignments.
- **DISABLED**: The proxy is saved but paused. Its domain rows and global selection, if any, are preserved.

These card labels are not proof that Chrome accepted Chroma's PAC settings. The **Health** panel is authoritative for requested, master-paused, effective, externally controlled, and incomplete-release state. In particular, a saved GLOBAL selection is not effective while master protection is off or another controller owns Chrome's proxy setting.

## Example: Setting Up NordVPN

Many commercial VPN providers, including NordVPN, ExpressVPN, and PIA, operate browser-compatible proxy servers. Here is how to route specific domains through a NordVPN HTTPS proxy server, such as Belize #1:

1. **Protocol:** Select `HTTPS` from the dropdown.
2. **Host:** Enter `bz1.proxy.nordvpn.com`.
3. **Port:** Enter `89`. This is commonly used by NordVPN HTTPS/HTTP SSL proxy endpoints.
4. **Username & Password:** You cannot use your standard NordAccount email/password. Use your auto-generated **Service Credentials**, which can be found in your NordAccount dashboard under **Services > NordVPN > Manual Setup**.
5. **Domains:** Add the domains you want to route, such as `youtube.com`, to the active list.
6. Click **Accept Settings**.

This provider-specific example was last reviewed on May 11, 2026. It may require converting Nord's displayed server address from `bz1.nordvpn.com` to the browser-compatible proxy host form `bz1.proxy.nordvpn.com`. Other proxy providers may use different hostnames, ports, protocols, and credential requirements, so follow your provider's current proxy setup instructions.

Proxy-region performance can vary by provider, route, and streaming service. If YouTube buffers above 1080p or struggles in fullscreen, try another nearby proxy region before assuming the extension is at fault.

## Smart-Link Auto-Expansion

To prevent infinite spin and geo-blocking issues caused by IP mismatches between a site's UI and its video delivery network, Chroma includes a **Smart-Link** system. When you add a major streaming service to your proxy list, Chroma automatically identifies and proxies its associated media delivery networks.

For example, adding `youtube.com` automatically proxies `googlevideo.com`, `ytimg.com`, and `youtube-nocookie.com`, ensuring that the video stream itself originates from the same proxy IP as your main session.

Supported services include:

- **YouTube**: `googlevideo.com`, `ytimg.com`, `ggpht.com`, `youtube-nocookie.com`, `youtu.be`, `youtubei.googleapis.com`, `youtube.googleapis.com`
- **Netflix**: `netflix.net`, `nflxvideo.net`, `nflxext.com`, `nflximg.com`, `nflximg.net`, `nflxso.net`, `nflxsearch.net`
- **Amazon Prime Video**: `amazonvideo.com`, `primevideo.com`, `aiv-cdn.net`, `pv-cdn.net`, `aiv-delivery.net`, `media-amazon.com`, `ssl-images-amazon.com`, plus global TLDs such as `.de` and `.co.jp`
- **Twitch**: `ttvnw.net`, `jtvnw.net`, `twitchcdn.net`
- **Disney+**: `disney-plus.net`, `dssott.com`, `dssedge.com`, `bamgrid.com`, `disney-plus.com`
- **Hulu**: `hulumail.com`, `huluim.com`, `hulu.hbomax.com`
- **Max (HBO)**: `hbomax.com`, `hbo.com`, `hbonow.com`, `hbogo.com`
- **Spotify**: `scdn.co`, `spotify.net`, `audio-ak-spotify-com.akamaized.net`

---

Next: [YouTube Protection](YOUTUBE.md)
