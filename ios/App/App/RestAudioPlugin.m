#import <Capacitor/Capacitor.h>

// Capacitor si pluginy hledá přes Objective-C runtime, ne přes Swift import —
// bez tohohle registračního souboru by JS strana (Capacitor.Plugins.RestAudio)
// o RestAudioPlugin.swift vůbec nevěděla.
CAP_PLUGIN(RestAudioPlugin, "RestAudio",
    CAP_PLUGIN_METHOD(arm, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cancel, CAPPluginReturnPromise);
)
