import CoreAudio
import Foundation
import IOKit

/// CoreAudio の入力デバイスの列挙と、一覧・既定デバイスの変化の監視
enum AudioDevices {
    struct Device: Equatable {
        let id: AudioDeviceID
        let uid: String
        let name: String
        let transport: String
        let isVirtual: Bool
        let isAlive: Bool
    }

    static func list() -> [Device] {
        allDeviceIDs().compactMap(device(for:)).filter { $0.isAlive }
    }

    static func payloads() -> [AudioDevicePayload] {
        let def = defaultInputDeviceID()
        return list().map {
            AudioDevicePayload(id: $0.uid, name: $0.name, isDefault: $0.id == def, transport: $0.transport, isVirtual: $0.isVirtual)
        }
    }

    static func device(for id: AudioDeviceID) -> Device? {
        guard inputChannelCount(id) > 0 else { return nil }
        if getUInt32(id, kAudioDevicePropertyIsHidden) == 1 { return nil }
        guard let uid = getString(id, kAudioDevicePropertyDeviceUID) else { return nil }
        // AVAudioEngine などが一時的に作る集約デバイスは一覧に出さない
        if uid.hasPrefix("CADefaultDeviceAggregate") { return nil }
        let name = getString(id, kAudioObjectPropertyName) ?? uid
        let transportCode = getUInt32(id, kAudioDevicePropertyTransportType) ?? 0
        let transport = transportName(transportCode)
        let isVirtual = transport == "virtual" || transport == "aggregate" || looksVirtual(name: name, uid: uid)
        let alive = (getUInt32(id, kAudioDevicePropertyDeviceIsAlive) ?? 1) != 0
        return Device(id: id, uid: uid, name: name, transport: transport, isVirtual: isVirtual, isAlive: alive)
    }

    static func device(uid: String) -> Device? {
        list().first { $0.uid == uid }
    }

    static func defaultInputDeviceID() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return st == noErr && id != 0 ? id : nil
    }

    static func defaultInputDevice() -> Device? {
        defaultInputDeviceID().flatMap(device(for:))
    }

    /// ノートの蓋が閉じているか（IOPMrootDomain の AppleClamshellState）。閉じていると内蔵マイクは無音になる
    static func isClamshellClosed() -> Bool {
        let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard svc != 0 else { return false }
        defer { IOObjectRelease(svc) }
        guard let v = IORegistryEntryCreateCFProperty(svc, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() else { return false }
        return (v as? Bool) ?? false
    }

    /// 蓋が閉じているときに内蔵の入力を避ける（REC-3）。ほかに入力がなければそのまま返す
    static func avoidingClosedLid(_ device: Device) -> Device {
        guard device.transport == "builtin", isClamshellClosed() else { return device }
        let alt = defaultInputDevice().flatMap { $0.transport == "builtin" || !$0.isAlive ? nil : $0 }
            ?? list().first { $0.transport != "builtin" && !$0.isVirtual }
        if let alt {
            Log.info("lid is closed; using \(alt.name) instead of built-in input \(device.name)")
            return alt
        }
        Log.info("lid is closed but no other input is available; using \(device.name)")
        return device
    }

    static func transportName(_ code: UInt32) -> String {
        switch code {
        case kAudioDeviceTransportTypeBuiltIn: return "builtin"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
        case kAudioDeviceTransportTypeContinuityCaptureWireless: return "bluetooth" // iPhone のマイク（無線）。遅延の性質が近い
        case kAudioDeviceTransportTypeContinuityCaptureWired: return "usb"
        default: return "unknown"
        }
    }

    /// 仮想デバイスによくある名前（transport が virtual になっていない製品向け）
    static func looksVirtual(name: String, uid: String) -> Bool {
        let s = (name + " " + uid).lowercased()
        let patterns = ["blackhole", "loopback", "soundflower", "zoomaudiodevice", "zoom audio", "teams audio",
                        "microsoft teams", "krisp", "audio hijack", "rogue amoeba", "virtual", "obs ", "camo",
                        "ecamm", "nvidia broadcast", "descript", "voicemeeter", "cadefaultdeviceaggregate"]
        return patterns.contains { s.contains($0) }
    }

    // MARK: - 監視

    private static let listenerQueue = DispatchQueue(label: "longhand.audio.devices")
    nonisolated(unsafe) private static var installed = false
    nonisolated(unsafe) private static var pending: DispatchWorkItem?
    nonisolated(unsafe) private static var lastPayloads: [AudioDevicePayload] = []

    /// 一覧か既定デバイスが変わったら（300ms まとめて）handler を呼ぶ
    static func startMonitoring(_ handler: @escaping @Sendable ([AudioDevicePayload]) -> Void) {
        listenerQueue.sync {
            guard !installed else { return }
            installed = true
            lastPayloads = payloads()
        }
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            pending?.cancel()
            let item = DispatchWorkItem {
                let now = payloads()
                guard now != lastPayloads else { return }
                lastPayloads = now
                handler(now)
            }
            pending = item
            listenerQueue.asyncAfter(deadline: .now() + 0.3, execute: item)
        }
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
            var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, listenerQueue, block)
        }
    }

    // MARK: - CoreAudio の小道具

    static func allDeviceIDs() -> [AudioDeviceID] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func inputChannelCount(_ id: AudioDeviceID) -> Int {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                              mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func getString(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
        guard st == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    static func getUInt32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }
}
