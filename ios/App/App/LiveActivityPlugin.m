#import <Capacitor/Capacitor.h>

// Registrace pro Objective-C runtime — bez ní by Capacitor.Plugins.WorkoutLiveActivity
// na JS straně neexistoval, i když je Swift třída v targetu.
CAP_PLUGIN(LiveActivityPlugin, "WorkoutLiveActivity",
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(update, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(end, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(consumeSkipRequest, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(status, CAPPluginReturnPromise);
)
