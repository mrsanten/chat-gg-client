#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>

// ─────────────────────────────────────────────────────────────────────────
// APNs (Apple Push Notification service) bootstrap.
//
// Tauri 2 iOS sam tworzy UIApplicationDelegate (z wry/winit). Żeby przechwycić
// callback `application:didRegisterForRemoteNotificationsWithDeviceToken:`
// (gdzie Apple dostarcza nam device token), robimy method swizzling: dodajemy
// nasz IMP do klasy delegate-a w runtime, jak tylko app się odpali.
//
// Token zapisujemy do `<Caches>/apns_token.txt`, gdzie Rust/JS go odczyta
// przez Tauri fs API i wyśle na server (POST /me/devices).
// ─────────────────────────────────────────────────────────────────────────

static NSString *apns_token_file_path(void) {
    NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(
        NSCachesDirectory, NSUserDomainMask, YES);
    return [paths.firstObject stringByAppendingPathComponent:@"apns_token.txt"];
}

static void apns_save_token(NSString *hex) {
    NSError *err = nil;
    BOOL ok = [hex writeToFile:apns_token_file_path()
                    atomically:YES
                      encoding:NSUTF8StringEncoding
                         error:&err];
    if (!ok) {
        NSLog(@"[apns] failed to save token: %@", err);
    } else {
        NSLog(@"[apns] token saved (%lu chars) to %@",
              (unsigned long)hex.length, apns_token_file_path());
    }
}

static void apns_did_register(id self, SEL _cmd,
                              UIApplication *app, NSData *tokenData) {
    NSMutableString *hex = [NSMutableString stringWithCapacity:tokenData.length * 2];
    const unsigned char *bytes = (const unsigned char *)tokenData.bytes;
    for (NSUInteger i = 0; i < tokenData.length; i++) {
        [hex appendFormat:@"%02x", bytes[i]];
    }
    NSLog(@"[apns] device token registered: %@", hex);
    apns_save_token(hex);
}

static void apns_did_fail(id self, SEL _cmd,
                          UIApplication *app, NSError *err) {
    NSLog(@"[apns] failed to register for remote notifications: %@", err);
}

@interface ApnsBootstrap : NSObject<UNUserNotificationCenterDelegate>
@end

@implementation ApnsBootstrap

+ (void)load {
    // Czekamy na UIApplicationDidFinishLaunchingNotification — wtedy
    // wry/winit już ustawiło swoje UIApplicationDelegate. Wtedy
    // robimy swizzle + request permission + registerForRemoteNotifications.
    [[NSNotificationCenter defaultCenter]
        addObserver:[ApnsBootstrap class]
           selector:@selector(appDidFinishLaunching:)
               name:UIApplicationDidFinishLaunchingNotification
             object:nil];
}

+ (void)appDidFinishLaunching:(NSNotification *)note {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        UIApplication *app = [UIApplication sharedApplication];
        id<UIApplicationDelegate> delegate = app.delegate;
        if (delegate) {
            Class delegateClass = object_getClass(delegate);
            // Dorzucamy nasze metody do klasy delegate-a (jeśli ich nie ma).
            // Encoding "v@:@@" = void return, self+_cmd, dwa pointer args
            // (UIApplication*, NSData* lub NSError*).
            class_addMethod(
                delegateClass,
                @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:),
                (IMP)apns_did_register,
                "v@:@@");
            class_addMethod(
                delegateClass,
                @selector(application:didFailToRegisterForRemoteNotificationsWithError:),
                (IMP)apns_did_fail,
                "v@:@@");
            NSLog(@"[apns] hooked delegate class %s", class_getName(delegateClass));
        } else {
            NSLog(@"[apns] no UIApplicationDelegate yet, can't swizzle");
        }

        // Ustaw siebie jako UNUserNotificationCenter delegate żeby banner-y
        // wyświetlały się też gdy app jest w foreground (default iOS chowa).
        static ApnsBootstrap *instance = nil;
        if (instance == nil) {
            instance = [[ApnsBootstrap alloc] init];
        }
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        center.delegate = instance;

        // Spytaj usera o pozwolenie. Jeśli już granted/denied — system
        // zwróci od razu bez UI prompta.
        UNAuthorizationOptions opts = UNAuthorizationOptionAlert
                                    | UNAuthorizationOptionBadge
                                    | UNAuthorizationOptionSound;
        [center requestAuthorizationWithOptions:opts
                              completionHandler:^(BOOL granted, NSError *error) {
            NSLog(@"[apns] auth granted=%d error=%@", granted, error);
            if (granted) {
                // registerForRemoteNotifications MUSI być na main queue.
                dispatch_async(dispatch_get_main_queue(), ^{
                    [app registerForRemoteNotifications];
                });
            }
        }];
    });
}

// Pokaż banner gdy app jest w foreground (iOS 14+ default suppresses these).
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner
                    | UNNotificationPresentationOptionSound
                    | UNNotificationPresentationOptionBadge
                    | UNNotificationPresentationOptionList);
}

// Tap na banner / lockscreen notyfikacji → otwórz konwersację z tym peerem.
// Server APNs payload zawiera custom field `peer` z username nadawcy. Tu
// zapisujemy do <Caches>/apns_pending_open.txt; JS po starcie/focus reads
// ten plik (przez Rust command get_apns_pending_open) i wywołuje
// onSelectPeer(username).
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    NSDictionary *userInfo = response.notification.request.content.userInfo;
    id peer = userInfo[@"peer"];
    if ([peer isKindOfClass:[NSString class]]) {
        NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(
            NSCachesDirectory, NSUserDomainMask, YES);
        NSString *path = [paths.firstObject
            stringByAppendingPathComponent:@"apns_pending_open.txt"];
        NSError *err = nil;
        BOOL ok = [(NSString *)peer writeToFile:path
                                     atomically:YES
                                       encoding:NSUTF8StringEncoding
                                          error:&err];
        if (!ok) {
            NSLog(@"[apns] failed to save pending_open: %@", err);
        } else {
            NSLog(@"[apns] pending_open=%@", peer);
        }
    }
    completionHandler();
}

@end

int main(int argc, char * argv[]) {
	// Wymuś load symbolu — bez tego linker może strip-nąć ApnsBootstrap
	// (klasa nie jest nigdzie explicit referenced w Rust/C++, tylko przez
	// `+load` runtime). Tutaj „touchujemy" klasę żeby ObjC runtime ją
	// załadował i wywołał `+load`.
	[ApnsBootstrap class];
	ffi::start_app();
	return 0;
}
