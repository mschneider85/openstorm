import Capacitor
import ExternalAccessory
import Foundation

/// Talks to a LEGO MINDSTORMS EV3 over Bluetooth via the External Accessory framework.
/// The brick must have "iPhone/iPad/iPod" enabled in its Bluetooth menu and be paired
/// in the iPad settings (or via `showPicker`). Raw bytes are passed through to JavaScript,
/// which handles the EV3 protocol.
@objc(EV3Plugin)
public class EV3Plugin: CAPPlugin, CAPBridgedPlugin, StreamDelegate {
    public let identifier = "EV3Plugin"
    public let jsName = "EV3"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]

    static let protocolString = "COM.LEGO.MINDSTORMS.EV3"

    private var session: EASession?
    private var pending = Data()

    override public func load() {
        EAAccessoryManager.shared().registerForLocalNotifications()
        NotificationCenter.default.addObserver(
            self, selector: #selector(accessoryDidDisconnect(_:)),
            name: .EAAccessoryDidDisconnect, object: nil)
    }

    private func bricks() -> [EAAccessory] {
        EAAccessoryManager.shared().connectedAccessories.filter {
            $0.protocolStrings.contains(EV3Plugin.protocolString)
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let devices = bricks().map { ["id": $0.connectionID, "name": $0.name] as [String: Any] }
        call.resolve(["devices": devices])
    }

    @objc func showPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            EAAccessoryManager.shared().showBluetoothAccessoryPicker(withNameFilter: nil) { error in
                guard let error = error as? EABluetoothAccessoryPickerError else {
                    call.resolve(["cancelled": false])
                    return
                }
                switch error.code {
                case .alreadyConnected: call.resolve(["cancelled": false])
                case .resultCancelled: call.resolve(["cancelled": true])
                default: call.reject("Kopplung fehlgeschlagen: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.close()
            let id = call.getInt("id")
            guard let accessory = self.bricks().first(where: { id == nil || $0.connectionID == id! }) else {
                call.reject("Kein gekoppelter EV3 gefunden")
                return
            }
            guard let session = EASession(accessory: accessory, forProtocol: EV3Plugin.protocolString),
                  let input = session.inputStream, let output = session.outputStream else {
                call.reject("Verbindung zum EV3 konnte nicht geöffnet werden")
                return
            }
            for stream in [input, output] as [Stream] {
                stream.delegate = self
                stream.schedule(in: .main, forMode: .default)
                stream.open()
            }
            self.session = session
            call.resolve(["name": accessory.name])
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("Ungültige Daten")
            return
        }
        DispatchQueue.main.async {
            guard self.session != nil else {
                call.reject("Nicht verbunden")
                return
            }
            self.pending.append(data)
            self.flush()
            call.resolve()
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.close()
            call.resolve()
        }
    }

    private func flush() {
        guard let output = session?.outputStream else { return }
        while output.hasSpaceAvailable && !pending.isEmpty {
            let written = pending.withUnsafeBytes { buffer in
                output.write(buffer.bindMemory(to: UInt8.self).baseAddress!, maxLength: buffer.count)
            }
            if written <= 0 { break }
            pending.removeFirst(written)
        }
    }

    private func readAvailable(_ input: InputStream) {
        var buffer = [UInt8](repeating: 0, count: 1024)
        var received = Data()
        while input.hasBytesAvailable {
            let count = input.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            received.append(buffer, count: count)
        }
        if !received.isEmpty {
            notifyListeners("data", data: ["data": received.base64EncodedString()])
        }
    }

    public func stream(_ stream: Stream, handle event: Stream.Event) {
        switch event {
        case .hasBytesAvailable:
            if let input = stream as? InputStream { readAvailable(input) }
        case .hasSpaceAvailable:
            flush()
        case .errorOccurred, .endEncountered:
            if session != nil {
                close()
                notifyListeners("disconnected", data: ["reason": "Bluetooth-Verbindung unterbrochen"])
            }
        default:
            break
        }
    }

    @objc private func accessoryDidDisconnect(_ notification: Notification) {
        guard let accessory = notification.userInfo?[EAAccessoryKey] as? EAAccessory,
              accessory.connectionID == session?.accessory?.connectionID else { return }
        close()
        notifyListeners("disconnected", data: ["reason": "EV3 ausgeschaltet oder außer Reichweite"])
    }

    private func close() {
        guard let session = session else { return }
        let streams: [Stream?] = [session.inputStream, session.outputStream]
        for stream in streams.compactMap({ $0 }) {
            stream.close()
            stream.remove(from: .main, forMode: .default)
            stream.delegate = nil
        }
        self.session = nil
        pending.removeAll()
    }
}
