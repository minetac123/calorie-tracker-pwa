#import <Capacitor/Capacitor.h>

// Capacitor si pluginy hledá přes Objective-C runtime, ne přes Swift import —
// bez tohohle registračního souboru by JS strana (Capacitor.Plugins.UpdateChecker)
// o UpdateCheckerPlugin.swift vůbec nevěděla.
CAP_PLUGIN(UpdateCheckerPlugin, "UpdateChecker",
    CAP_PLUGIN_METHOD(checkNow, CAPPluginReturnPromise);
)
