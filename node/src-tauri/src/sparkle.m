#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#include <stdbool.h>

extern bool node_sparkle_reserve_idle_node(void);
extern void node_sparkle_release_node(void);

// Load Sparkle from the shipped bundle. Cargo tests and unbundled dev builds
// can run without a framework installed on the build machine.
@interface NSObject (NodeSparkleSelectors)
- (instancetype)initWithStartingUpdater:(BOOL)start updaterDelegate:(id)delegate userDriverDelegate:(id)userDriver;
- (id)updater;
- (BOOL)startUpdater:(NSError **)error;
- (BOOL)canCheckForUpdates;
- (void)checkForUpdates:(id)sender;
@end

@interface NodeUpdateDelegate : NSObject
@property(nonatomic, strong) NSTimer *idleTimer;
@end

@implementation NodeUpdateDelegate

- (BOOL)updater:(id)updater willInstallUpdateOnQuit:(id)item immediateInstallationBlock:(void (^)(void))install {
    // A background node can stay open for weeks. Request installation now;
    // Sparkle calls the relaunch delegate below before it terminates the app.
    install();
    return YES;
}

- (BOOL)updater:(id)updater shouldPostponeRelaunchForUpdate:(id)item untilInvokingBlock:(void (^)(void))install {
    if (node_sparkle_reserve_idle_node()) return NO;

    self.idleTimer = [NSTimer timerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *timer) {
        if (node_sparkle_reserve_idle_node()) {
            [timer invalidate];
            install();
        }
    }];
    [[NSRunLoop mainRunLoop] addTimer:self.idleTimer forMode:NSRunLoopCommonModes];
    return YES;
}

- (void)updater:(id)updater didFinishUpdateCycleForUpdateCheck:(NSInteger)check error:(NSError *)error {
    [self.idleTimer invalidate];
    self.idleTimer = nil;
    node_sparkle_release_node();
}

@end

static NodeUpdateDelegate *updateDelegate;
static id updaterController;

bool node_sparkle_start(void) {
    if (![NSThread isMainThread]) return false;
    if (updaterController) return true;

    NSBundle *app = NSBundle.mainBundle;
    if (![app objectForInfoDictionaryKey:@"SUPublicEDKey"] || !app.privateFrameworksPath) return false;

    NSString *path = [app.privateFrameworksPath stringByAppendingPathComponent:@"Sparkle.framework"];
    NSError *error = nil;
    NSBundle *sparkle = [NSBundle bundleWithPath:path];
    if (![sparkle loadAndReturnError:&error]) {
        NSLog(@"Relay Node could not load Sparkle: %@", error);
        return false;
    }

    Class controllerClass = [sparkle classNamed:@"SPUStandardUpdaterController"];
    updateDelegate = [NodeUpdateDelegate new];
    id controller = [[controllerClass alloc] initWithStartingUpdater:NO updaterDelegate:updateDelegate userDriverDelegate:nil];
    if (![[controller updater] startUpdater:&error]) {
        NSLog(@"Relay Node could not start Sparkle: %@", error);
        updateDelegate = nil;
        return false;
    }
    updaterController = controller;
    return true;
}

void node_sparkle_check_for_updates(void) {
    if ([NSThread isMainThread] && [[updaterController updater] canCheckForUpdates]) {
        [updaterController checkForUpdates:nil];
    }
}
