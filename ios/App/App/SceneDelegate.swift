import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    // Kontrola aktualizací. Běží tady, ne v willConnectTo, aby se chytlo i
    // vrácení do appky po delší době — sideloadovaná appka nemá App Store,
    // který by ji aktualizoval sám. UpdateChecker si sám hlídá, aby se ptal
    // nejvýš jednou za pár hodin, takže tohle nespamuje.
    //
    // Krátké zpoždění dá Capacitoru čas dokreslit webview; dialog vytažený
    // přesně v okamžiku aktivace scény umí skončit pod ním.
    func sceneDidBecomeActive(_ scene: UIScene) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            UpdateChecker.checkAndPrompt()
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
