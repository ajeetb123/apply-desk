import Carbon

/// A system-wide keyboard shortcut. Carbon hot keys work while other apps
/// are frontmost and need no Accessibility permission.
final class HotKey {
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var installed = false
    private static var nextID: UInt32 = 1
    private var reference: EventHotKeyRef?
    /// False when another app already owns this shortcut.
    private(set) var isRegistered = false

    init(keyCode: Int, modifiers: Int, handler: @escaping () -> Void) {
        HotKey.installHandler()
        let id = HotKey.nextID
        HotKey.nextID += 1
        HotKey.handlers[id] = handler
        let hotKeyID = EventHotKeyID(signature: OSType(0x4150_4453), id: id) // "APDS"
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID, GetApplicationEventTarget(), 0, &reference)
        isRegistered = status == noErr
        if !isRegistered { NSLog("Apply Desk couldn't register its shortcut (status %d); another app may use it", status) }
    }

    deinit {
        if let reference = reference { UnregisterEventHotKey(reference) }
    }

    private static func installHandler() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            let id = hotKeyID.id
            DispatchQueue.main.async { HotKey.handlers[id]?() }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
