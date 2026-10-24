import Capacitor
import UIKit

/// Registers the app's own native plugins with the Capacitor bridge.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(EV3Plugin())
    }
}
