import Accelerate
import CoreAudio
import Darwin
import Foundation

private let sampleCount: Int = 2048
private let bandCount: Int = 24

private func normalized(_ value: Float) -> Float {
    value.isFinite ? min(1, max(0, value)) : 0
}

private func visualLevel(_ amplitude: Float) -> Float {
    guard amplitude.isFinite, amplitude > 0.00031623 else { return 0 }
    return normalized((20 * log10(amplitude) + 70) / 70)
}

private enum Mode: Equatable {
    case capture, check, selfTest, invalid

    init(_ arguments: [String]) {
        switch arguments {
        case ["--capture-spotify"]: self = .capture
        case ["--check"]: self = .check
        case ["--self-test"]: self = .selfTest
        default: self = .invalid
        }
    }
}

// Writes run only on the main queue. A slow reader must not stall cleanup.
@discardableResult
private func emit(_ object: [String: Any], dropIfBusy: Bool = false) -> Bool {
    guard var data: Data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return false }
    data.append(10)
    return data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> Bool in
        let written: Int = Darwin.write(STDOUT_FILENO, bytes.baseAddress!, bytes.count)
        return written == bytes.count || (dropIfBusy && written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
    }
}

private struct Spectrum {
    let bands: [Float]
    let level: Float
}

private final class Analyzer {
    private let setup: FFTSetup
    private var window: [Float] = [Float](repeating: 0, count: sampleCount)
    private var real: [Float] = [Float](repeating: 0, count: sampleCount)
    private var imaginary: [Float] = [Float](repeating: 0, count: sampleCount)

    init() {
        guard let setup: FFTSetup = vDSP_create_fftsetup(11, FFTRadix(kFFTRadix2)) else {
            fatalError("Unable to allocate FFT setup")
        }
        self.setup = setup
        vDSP_hann_window(&window, vDSP_Length(sampleCount), Int32(vDSP_HANN_NORM))
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func analyze(_ samples: [Float], sampleRate: Double) -> Spectrum {
        var energy: Double = 0
        for index: Int in 0..<sampleCount {
            let value: Float = samples[index].isFinite ? samples[index] : 0
            energy += Double(value) * Double(value)
            real[index] = value * window[index]
            imaginary[index] = 0
        }
        var bands: [Float] = [Float](repeating: 0, count: bandCount)
        guard energy > 0, sampleRate.isFinite, sampleRate > 90 else {
            return Spectrum(bands: bands, level: 0)
        }
        real.withUnsafeMutableBufferPointer { (realBuffer: inout UnsafeMutableBufferPointer<Float>) in
            imaginary.withUnsafeMutableBufferPointer { (imaginaryBuffer: inout UnsafeMutableBufferPointer<Float>) in
                var split: DSPSplitComplex = DSPSplitComplex(realp: realBuffer.baseAddress!, imagp: imaginaryBuffer.baseAddress!)
                vDSP_fft_zip(setup, &split, 1, 11, FFTDirection(FFT_FORWARD))
            }
        }
        let upper: Double = min(16_000, sampleRate / 2)
        let ratio: Double = upper / 45
        for bin: Int in 1..<(sampleCount / 2) {
            let frequency: Double = Double(bin) * sampleRate / Double(sampleCount)
            guard frequency >= 45, frequency < upper else { continue }
            let band: Int = min(bandCount - 1, Int(log(frequency / 45) / log(ratio) * Double(bandCount)))
            let amplitude: Float = hypot(real[bin], imaginary[bin]) * 4 / Float(sampleCount)
            bands[band] = max(bands[band], visualLevel(amplitude))
        }
        return Spectrum(bands: bands, level: normalized(Float(sqrt(energy / Double(sampleCount)))))
    }
}

// Fixed storage; callback uses try-lock and drops samples rather than blocking audio.
private final class SampleBuffer: @unchecked Sendable {
    private let lock: NSLock = NSLock()
    private let storage: UnsafeMutablePointer<Float> = .allocate(capacity: sampleCount)
    private var cursor: Int = 0
    private var available: Int = 0
    private var updated: Bool = false
    private var invalid: Bool = false

    init() { storage.initialize(repeating: 0, count: sampleCount) }
    deinit { storage.deinitialize(count: sampleCount); storage.deallocate() }

    func append(_ input: UnsafePointer<AudioBufferList>, channels: Int, interleaved: Bool) {
        guard lock.try() else { return }
        defer { lock.unlock() }
        let buffers: UnsafeMutableAudioBufferListPointer = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard channels > 0, buffers.count == (interleaved ? 1 : channels) else { invalid = true; return }
        var frames: Int = Int.max
        for buffer: AudioBuffer in buffers {
            let expectedChannels: Int = interleaved ? channels : 1
            guard Int(buffer.mNumberChannels) == expectedChannels,
                  buffer.mDataByteSize % UInt32(expectedChannels * MemoryLayout<Float>.size) == 0 else { invalid = true; return }
            let count: Int = Int(buffer.mDataByteSize) / (expectedChannels * MemoryLayout<Float>.size)
            if count > 0 && buffer.mData == nil { invalid = true; return }
            frames = min(frames, count)
        }
        guard frames > 0, frames != Int.max else { return }
        // Only the newest FFT window matters, even if the device sends a large block.
        for frame: Int in max(0, frames - sampleCount)..<frames {
            var mono: Float = 0
            for channel: Int in 0..<channels {
                let buffer: AudioBuffer = buffers[interleaved ? 0 : channel]
                let data: UnsafePointer<Float> = UnsafePointer(buffer.mData!.assumingMemoryBound(to: Float.self))
                let value: Float = data[interleaved ? frame * channels + channel : frame]
                mono += (value.isFinite ? value : 0) / Float(channels)
            }
            storage[cursor] = mono.isFinite ? mono : 0
            cursor = (cursor + 1) % sampleCount
            available = min(sampleCount, available + 1)
        }
        updated = true
    }

    func snapshot() -> (samples: [Float], invalid: Bool) {
        lock.lock()
        defer { lock.unlock() }
        var samples: [Float] = [Float](repeating: 0, count: sampleCount)
        if updated {
            for index: Int in 0..<available {
                samples[sampleCount - available + index] = storage[(cursor - available + index + sampleCount) % sampleCount]
            }
        } else {
            available = 0
        }
        updated = false
        return (samples, invalid)
    }
}

private struct CaptureError: Error {
    let message: String
}

private func requireSuccess(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else {
        throw CaptureError(message: "\(operation) failed (CoreAudio \(status)). Check Screen & System Audio Recording permission for Spotify Audio Helper, then click Start again.")
    }
}

private final class Capture: @unchecked Sendable {
    private var tap: AudioObjectID = kAudioObjectUnknown
    private var device: AudioObjectID = kAudioObjectUnknown
    private var ioProc: AudioDeviceIOProcID?
    private var started: Bool = false
    private var stopped: Bool = false
    private var sources: [any DispatchSourceProtocol] = []
    private let buffer: SampleBuffer = SampleBuffer()
    private let analyzer: Analyzer = Analyzer()
    private var sampleRate: Double = 48_000
    private var lastFrameTime: UInt64 = 0
    private let originalParent: pid_t = getppid()

    func start() throws {
        installLifetimeWatchers()
        guard originalParent > 1, getppid() == originalParent else { throw CaptureError(message: "Controller has exited.") }
        let description: CATapDescription = CATapDescription(stereoMixdownOfProcesses: [])
        description.bundleIDs = ["com.spotify.client"]
        description.isProcessRestoreEnabled = true
        description.isPrivate = true
        description.isExclusive = false
        description.muteBehavior = .unmuted
        description.name = "Spotify Visualizer"
        try requireSuccess(AudioHardwareCreateProcessTap(description, &tap), "Creating Spotify-only audio tap")

        var uidReference: Unmanaged<CFString>?
        var uidSize: UInt32 = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var uidAddress: AudioObjectPropertyAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        try requireSuccess(AudioObjectGetPropertyData(tap, &uidAddress, 0, nil, &uidSize, &uidReference), "Reading tap identifier")
        guard let uidReference: Unmanaged<CFString> = uidReference else { throw CaptureError(message: "Spotify audio tap returned no identifier.") }
        let uid: CFString = uidReference.takeRetainedValue()
        var format: AudioStreamBasicDescription = AudioStreamBasicDescription()
        var formatSize: UInt32 = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress: AudioObjectPropertyAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        try requireSuccess(AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &formatSize, &format), "Reading Spotify audio format")
        let interleaved: Bool = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        let channels: Int = Int(format.mChannelsPerFrame)
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
              format.mBitsPerChannel == 32, channels > 0, channels <= 2,
              format.mBytesPerFrame == UInt32((interleaved ? channels : 1) * 4),
              format.mSampleRate.isFinite, format.mSampleRate > 90 else {
            throw CaptureError(message: "Spotify audio format is unsupported; expected native-endian packed Float32 mono or stereo.")
        }
        sampleRate = format.mSampleRate
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Spotify Visualizer Private Tap",
            kAudioAggregateDeviceUIDKey: "dev.jenice11.orca.spotify-visualizer.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: uid]],
        ]
        try requireSuccess(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Creating private Spotify tap device")
        let sampleBuffer: SampleBuffer = buffer
        try requireSuccess(AudioDeviceCreateIOProcIDWithBlock(&ioProc, device, nil) { _, input, _, _, _ in
            sampleBuffer.append(input, channels: channels, interleaved: interleaved)
        }, "Creating Spotify audio reader")
        // Stop even if AudioDeviceStart reports a partially initialized failure.
        started = true
        try requireSuccess(AudioDeviceStart(device, ioProc), "Starting Spotify audio reader")
        guard emit(["type": "ready"]) else { finish(1) }
        let timer: any DispatchSourceTimer = DispatchSource.makeTimerSource(queue: .main)
        // About 9 Hz leaves room for ready/errors within half the bridge budget.
        timer.schedule(deadline: .now() + .milliseconds(110), repeating: .milliseconds(110), leeway: .milliseconds(1))
        timer.setEventHandler { [self] in
            guard getppid() == originalParent else { finish(0) }
            let now: UInt64 = DispatchTime.now().uptimeNanoseconds
            guard now - lastFrameTime >= 100_000_000 else { return }
            lastFrameTime = now
            let snapshot: (samples: [Float], invalid: Bool) = buffer.snapshot()
            guard !snapshot.invalid else { fail("Spotify delivered an unsupported audio buffer layout.") }
            let result: Spectrum = analyzer.analyze(snapshot.samples, sampleRate: sampleRate)
            if !emit(["type": "frame", "bands": result.bands, "level": result.level], dropIfBusy: true) { finish(0) }
        }
        sources.append(timer)
        timer.resume()
    }

    private func installLifetimeWatchers() {
        for number: Int32 in [SIGTERM, SIGINT, SIGPIPE] {
            signal(number, SIG_IGN)
            let source: any DispatchSourceSignal = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [self] in finish(0) }
            sources.append(source)
            source.resume()
        }
        let input: any DispatchSourceRead = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        _ = fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK)
        input.setEventHandler { [self] in
            var bytes: [UInt8] = [UInt8](repeating: 0, count: 256)
            let count: Int = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count == 0 || (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) { finish(0) }
        }
        sources.append(input)
        input.resume()
        let parent: any DispatchSourceProcess = DispatchSource.makeProcessSource(identifier: originalParent, eventMask: .exit, queue: .main)
        parent.setEventHandler { [self] in finish(0) }
        sources.append(parent)
        parent.resume()
    }

    func cleanup() {
        guard !stopped else { return }
        stopped = true
        if started { AudioDeviceStop(device, ioProc); started = false }
        if let ioProc: AudioDeviceIOProcID = ioProc { AudioDeviceDestroyIOProcID(device, ioProc); self.ioProc = nil }
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device); device = kAudioObjectUnknown }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = kAudioObjectUnknown }
        for source: any DispatchSourceProtocol in sources { source.cancel() }
        sources.removeAll()
    }

    func finish(_ status: Int32) -> Never { cleanup(); exit(status) }
    func fail(_ message: String) -> Never { emit(["type": "error", "message": message]); finish(1) }
}

private func selfTest() {
    func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { emit(["type": "error", "message": "Self-test failed: \(message)"]); exit(1) }
    }
    let analyzer: Analyzer = Analyzer()
    let silence: [Float] = [Float](repeating: 0, count: sampleCount)
    let zero: Spectrum = analyzer.analyze(silence, sampleRate: 48_000)
    check(zero.level == 0 && zero.bands.allSatisfy { $0 == 0 }, "silence")
    var sine: [Float] = [Float](repeating: 0, count: sampleCount)
    let frequency: Double = 984.375
    for index: Int in 0..<sampleCount { sine[index] = Float(sin(2 * .pi * frequency * Double(index) / 48_000)) }
    let spectrum: Spectrum = analyzer.analyze(sine, sampleRate: 48_000)
    let expected: Int = Int(log(frequency / 45) / log(16_000.0 / 45) * Double(bandCount))
    check(spectrum.bands[expected] == spectrum.bands.max() && spectrum.bands[expected] > 0.9, "sine peak")
    check(abs(spectrum.level - Float(1 / sqrt(2.0))) < 0.01, "RMS")
    let alternateRate: Spectrum = analyzer.analyze(sine, sampleRate: 44_100)
    let alternateBand: Int = Int(log((frequency * 44_100 / 48_000) / 45) / log(16_000.0 / 45) * Double(bandCount))
    check(alternateRate.bands[alternateBand] == alternateRate.bands.max(), "actual sample rate")
    let nonfinite: Spectrum = analyzer.analyze([Float](repeating: .nan, count: sampleCount), sampleRate: 44_100)
    check(nonfinite.level == 0 && nonfinite.bands.allSatisfy { $0 == 0 }, "nonfinite samples")
    check(normalized(.infinity) == 0 && normalized(-1) == 0 && normalized(2) == 1, "normalization")
    check(visualLevel(0) == 0 && visualLevel(.infinity) == 0 && visualLevel(0.01) > 0.4, "quiet audio uses a bounded decibel display")
    check(Mode([]) == .invalid && Mode(["--unknown"]) == .invalid && Mode(["--check", "--capture-spotify"]) == .invalid, "capture argument gate")
    check(Mode(["--check"]) == .check && Mode(["--self-test"]) == .selfTest && Mode(["--capture-spotify"]) == .capture, "safe modes")

    let interleaved: SampleBuffer = SampleBuffer()
    var stereo: [Float] = [1, 0, .nan, 1, -1, -1]
    stereo.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
        var list: AudioBufferList = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
        interleaved.append(&list, channels: 2, interleaved: true)
    }
    let mixed: [Float] = interleaved.snapshot().samples
    check(Array(mixed.suffix(3)) == [0.5, 0.5, -1], "interleaved stereo and nonfinite sanitization")
    check(interleaved.snapshot().samples.allSatisfy { $0 == 0 }, "stale audio becomes silence")
    let planar: SampleBuffer = SampleBuffer()
    let list: UnsafeMutableAudioBufferListPointer = AudioBufferList.allocate(maximumBuffers: 2)
    defer { free(list.unsafeMutablePointer) }
    var left: [Float] = [1, -1]
    var right: [Float] = [0, 1]
    left.withUnsafeMutableBytes { (leftBytes: UnsafeMutableRawBufferPointer) in
        right.withUnsafeMutableBytes { (rightBytes: UnsafeMutableRawBufferPointer) in
            list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(leftBytes.count), mData: leftBytes.baseAddress)
            list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(rightBytes.count), mData: rightBytes.baseAddress)
            planar.append(UnsafePointer(list.unsafeMutablePointer), channels: 2, interleaved: false)
        }
    }
    check(Array(planar.snapshot().samples.suffix(2)) == [0.5, 0], "noninterleaved stereo")
    let bounded: SampleBuffer = SampleBuffer()
    var large: [Float] = [Float](repeating: 0.25, count: sampleCount * 3)
    large.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
        var list: AudioBufferList = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
        bounded.append(&list, channels: 1, interleaved: true)
    }
    check(bounded.snapshot().samples.allSatisfy { $0 == 0.25 }, "oversized callbacks keep only latest window")
    let malformed: SampleBuffer = SampleBuffer()
    var empty: AudioBufferList = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: 7, mData: nil))
    malformed.append(&empty, channels: 2, interleaved: true)
    check(malformed.snapshot().invalid, "malformed buffers fail closed")
    emit(["type": "self-test", "ok": true])
}

_ = signal(SIGPIPE, SIG_IGN)
_ = fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK)
private let mode: Mode = Mode(Array(CommandLine.arguments.dropFirst()))
switch mode {
case .check:
    emit(["type": "check", "platform": "macOS", "minimumVersion": "26.0", "captureSupported": ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)), "captureStarted": false])
case .selfTest:
    selfTest()
case .invalid:
    emit(["type": "error", "message": "Usage: SpotifyAudioHelper --capture-spotify | --check | --self-test. Capture starts only with --capture-spotify."])
    exit(2)
case .capture:
    let capture: Capture = Capture()
    do {
        try capture.start()
        dispatchMain()
    } catch let error as CaptureError {
        capture.fail(error.message)
    } catch {
        capture.fail("Unable to start Spotify audio capture.")
    }
}
