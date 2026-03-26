import json

domains = [
    "amazon-adsystem.com", "aan.amazon.com", "googleadservices.com", "taboola.com",
    "trc.taboola.com", "images.taboola.com", "outbrain.com", "widgets.outbrain.com",
    "adnxs.com", "api.vungle.com", "vungle.com", "secure.adnxs.com", "prebid.adnxs.com",
    "rubiconproject.com", "init.supersonicads.com", "outcome-ssp.supersonicads.com",
    "smartyads.com", "sharethrough.com", "apex.go.sonobi.com", "a.teads.tv",
    "cdn.teads.tv", "doubleverify.com", "pixel.adsafeprotected.com",
    "static.adsafeprotected.com", "insightexpressai.com", "static.hotjar.com",
    "vars.hotjar.com", "cdn.segment.com", "api.segment.io", "rs.fullstory.com",
    "permutive.com", "cdn.permutive.com", "thetradedesk.com", "tapad.com",
    "prod.uidapi.com", "app.appsflyer.com", "appsflyer.com", "app.adjust.com",
    "adjust.com", "bnc.lt", "kochava.com", "control.kochava.com", "singular.net",
    "wzrkt.com", "clevertap-prod.com", "trafficjunky.net", "statdynamic.com",
    "sc-static.net", "tr.snapchat.com", "sc-analytics.appspot.com", "snap.licdn.com",
    "analytics.twitter.com", "ct.pinterest.com", "vk.com/rtrg", "top-fwz1.mail.ru",
    "xp.apple.com", "tracking.miui.com", "us.info.lgsmartad.com", "ngfts.lge.com",
    "smartclip.net", "settings-win.data.microsoft.com", "vortex.data.microsoft.com",
    "vortex-win.data.microsoft.com", "watson.telemetry.microsoft.com",
    "app-measurement.com", "firebase-settings.crashlytics.com", "www.anrdoezrs.net",
    "www.dpbolvw.net", "www.tkqlhce.com", "shareasale.com", "shareasale-analytics.com",
    "click.linksynergy.com", "track.linksynergy.com", "impact.com", "api.impact.com",
    "www.awin1.com", "zenaps.com", "partnerstack.com", "api.partnerstack.com",
    "refersion.com", "api.refersion.com", "t.skimresources.com", "go.skimresources.com",
    "redirector.skimresources.com", "redirect.viglink.com", "cdn.optimizely.com",
    "logx.optimizely.com", "cdn.dynamicyield.com", "track.hubspot.com",
    "trackcmp.net", "imasdk.googleapis.com", "cd.connatix.com", "capi.connatix.com",
    "vid.connatix.com", "tremorhub.com", "ads.tremorhub.com", "ssl.p.jwpcdn.com",
    "mssl.fwmrm.net"
]

start_id = 269936
rules = []

for i, domain in enumerate(domains):
    rule = {
        "id": start_id + i,
        "priority": 1,
        "action": { "type": "block" },
        "condition": {
            "urlFilter": f"||{domain}^",
            "resourceTypes": [
                "main_frame", "sub_frame", "script", "image", "stylesheet",
                "object", "xmlhttprequest", "ping", "media", "font", "other"
            ]
        }
    }
    rules.append(rule)

print(json.dumps(rules, indent=2))
