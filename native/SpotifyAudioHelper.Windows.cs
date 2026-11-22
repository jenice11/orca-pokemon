using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SpotifyAudioHelper
{
    private const int SampleCount = 2048;
    private const int BandCount = 24;
    private const int LoopbackFlag = 0x00020000;
    private const int SilentFlag = 0x2;
    private const int MaxChannels = 8;
    private const int ProcessLoopbackMinimumBuild = 20348;
    private const uint SnapshotProcesses = 0x2;
    private static int stopRequested;

    public static int Run(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length != 1)
        {
            EmitError("Usage: SpotifyAudioHelper.Windows.ps1 --capture-spotify | --self-test.");
            return 2;
        }
        if (args[0] == "--self-test") return SelfTest();
        if (args[0] != "--capture-spotify" && args[0] != "--capture-all-app")
        {
            EmitError("Usage: SpotifyAudioHelper.Windows.ps1 --capture-spotify | --capture-all-app | --self-test.");
            return 2;
        }
        try
        {
            Capture(args[0] == "--capture-all-app");
            return 0;
        }
        catch (Exception error)
        {
            EmitError(error.Message);
            return 1;
        }
    }

    private static void Capture(bool allApps)
    {
        bool spotifySupported = SupportsProcessLoopback();
        if (allApps && spotifySupported)
            throw new InvalidOperationException("All-app capture is only available when Spotify-only capture is unsupported.");
        if (!allApps && !spotifySupported)
            throw new InvalidOperationException("Spotify-only audio capture is unavailable on this Windows release.");
        List<AudioStream> streams = new List<AudioStream>();
        try
        {
            if (allApps)
            {
                streams.Add(OpenDefaultOutputStream());
            }
            else
            {
                List<uint> processIds = SpotifyProcessTreeRoots();
                if (processIds.Count == 0) throw new InvalidOperationException("Spotify desktop must be running before capture can start.");
                foreach (uint processId in processIds) streams.Add(OpenAudioStream(processId));
            }
            Console.WriteLine("{\"type\":\"ready\"}");
            Console.Out.Flush();

            Thread inputWatcher = new Thread(WatchInput);
            inputWatcher.IsBackground = true;
            inputWatcher.Start();
            Analyzer analyzer = new Analyzer();
            Stopwatch clock = Stopwatch.StartNew();
            long nextFrame = 0;
            while (Volatile.Read(ref stopRequested) == 0)
            {
                foreach (AudioStream stream in streams) ReadPackets(stream.Capture, stream.Samples);
                long now = clock.ElapsedMilliseconds;
                if (now >= nextFrame)
                {
                    EmitFrame(AnalyzeStreams(streams, analyzer));
                    nextFrame = now + 110;
                }
                Thread.Sleep(5);
            }
        }
        finally
        {
            foreach (AudioStream stream in streams) stream.Dispose();
        }
    }

    private static AudioStream OpenAudioStream(uint processId)
    {
        return OpenAudioStream(ActivateProcessLoopback(processId), "Spotify", true);
    }

    private static AudioStream OpenDefaultOutputStream()
    {
        return OpenAudioStream(ActivateDefaultOutput(), "Default output", false);
    }

    private static AudioStream OpenAudioStream(IAudioClient client, string source, bool handMadeFormat)
    {
        IAudioCaptureClient capture = null;
        IntPtr formatPointer = IntPtr.Zero;
        bool started = false;
        try
        {
            // Process loopback clients do not implement GetMixFormat (E_NOTIMPL), so the format is requested.
            if (handMadeFormat) formatPointer = RequestedFormat();
            else Check(client.GetMixFormat(out formatPointer), "Could not read " + source + "'s audio format.");
            WaveFormat format = WaveFormat.Read(formatPointer);
            if (format.Channels < 1 || format.Channels > MaxChannels || format.SampleRate < 8000 || format.SampleRate > 192000 ||
                format.BlockAlign != format.Channels * format.BytesPerSample ||
                !(format.IsFloat && format.Bits == 32) &&
                !(format.IsPcm && (format.Bits == 8 || format.Bits == 16 || format.Bits == 24 || format.Bits == 32)))
            {
                throw new InvalidOperationException(source + "'s Windows audio format is unsupported.");
            }

            Guid sessionId = Guid.Empty;
            Check(client.Initialize(0, LoopbackFlag, 1000000, 0, formatPointer, ref sessionId), "Could not initialize " + source + " loopback.");
            Guid captureId = typeof(IAudioCaptureClient).GUID;
            object captureObject;
            Check(client.GetService(ref captureId, out captureObject), "Could not open " + source + "'s audio stream.");
            capture = (IAudioCaptureClient)captureObject;
            Check(client.Start(), "Could not start " + source + " loopback.");
            started = true;
            return new AudioStream(client, capture, formatPointer, format);
        }
        catch
        {
            if (started) { try { client.Stop(); } catch { } }
            if (formatPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(formatPointer);
            Release(capture);
            Release(client);
            throw;
        }
    }

    private static IntPtr RequestedFormat()
    {
        IntPtr format = Marshal.AllocCoTaskMem(18);
        Marshal.WriteInt16(format, 0, 1);
        Marshal.WriteInt16(format, 2, 2);
        Marshal.WriteInt32(format, 4, 44100);
        Marshal.WriteInt32(format, 8, 44100 * 4);
        Marshal.WriteInt16(format, 12, 4);
        Marshal.WriteInt16(format, 14, 16);
        Marshal.WriteInt16(format, 16, 0);
        return format;
    }

    private static IAudioClient ActivateDefaultOutput()
    {
        IMMDeviceEnumerator enumerator = null;
        IMMDevice device = null;
        object activated = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Check(enumerator.GetDefaultAudioEndpoint(0, 0, out device), "Could not find the default audio output device.");
            Guid clientId = typeof(IAudioClient).GUID;
            Check(device.Activate(ref clientId, 23, IntPtr.Zero, out activated), "Could not open the default audio output device.");
            IAudioClient client = activated as IAudioClient;
            if (client == null) throw new InvalidOperationException("Windows did not return the default audio client.");
            return client;
        }
        finally
        {
            if (!(activated is IAudioClient)) Release(activated);
            Release(device);
            Release(enumerator);
        }
    }

    private static IAudioClient ActivateProcessLoopback(uint processId)
    {
        ActivationHandler handler = new ActivationHandler();
        AudioClientActivationParams activation = new AudioClientActivationParams();
        activation.ActivationType = 1;
        activation.TargetProcessId = processId;
        activation.ProcessLoopbackMode = 0;
        IntPtr activationPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AudioClientActivationParams)));
        IntPtr variantPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PropVariant)));
        IActivateAudioInterfaceAsyncOperation operation = null;
        try
        {
            Marshal.StructureToPtr(activation, activationPointer, false);
            PropVariant variant = new PropVariant();
            variant.Vt = 0x41;
            variant.BlobSize = (uint)Marshal.SizeOf(typeof(AudioClientActivationParams));
            variant.BlobData = activationPointer;
            Marshal.StructureToPtr(variant, variantPointer, false);
            Guid clientId = typeof(IAudioClient).GUID;
            Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref clientId, variantPointer, handler, out operation),
                "Could not request Spotify process loopback.");
            handler.Completed.WaitOne();
            Check(handler.Result, "Spotify process loopback is unavailable.");
            if (handler.Client == null) throw new InvalidOperationException("Windows did not return Spotify's audio client.");
            return handler.Client;
        }
        finally
        {
            GC.KeepAlive(handler);
            if (operation != null) Release(operation);
            Marshal.FreeHGlobal(variantPointer);
            Marshal.FreeHGlobal(activationPointer);
            handler.Dispose();
        }
    }

    private static List<uint> SpotifyProcessTreeRoots()
    {
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        HashSet<uint> spotify = new HashSet<uint>();
        uint currentSessionId;
        using (Process current = Process.GetCurrentProcess()) currentSessionId = (uint)current.SessionId;
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Could not inspect running Spotify processes.");
        try
        {
            ProcessEntry entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            bool found = Process32FirstW(snapshot, ref entry);
            while (found)
            {
                parents[entry.ProcessId] = entry.ParentProcessId;
                uint sessionId;
                if (String.Equals(entry.ExeFile, "Spotify.exe", StringComparison.OrdinalIgnoreCase) &&
                    ProcessIdToSessionId(entry.ProcessId, out sessionId) && sessionId == currentSessionId)
                    spotify.Add(entry.ProcessId);
                found = Process32NextW(snapshot, ref entry);
            }
            int error = Marshal.GetLastWin32Error();
            if (error != 18) throw new InvalidOperationException("Could not enumerate running Spotify processes.");
        }
        finally { CloseHandle(snapshot); }

        List<uint> roots = new List<uint>();
        foreach (uint processId in spotify)
        {
            uint parentId;
            if (!parents.TryGetValue(processId, out parentId) || !spotify.Contains(parentId)) roots.Add(processId);
        }
        roots.Sort();
        return roots;
    }

    private static Spectrum AnalyzeStreams(List<AudioStream> streams, Analyzer analyzer)
    {
        float[] bands = new float[BandCount];
        double energy = 0;
        int count = 0;
        foreach (AudioStream stream in streams)
        {
            Spectrum next = analyzer.Analyze(stream.Samples.Snapshot(), stream.Format.SampleRate);
            for (int i = 0; i < bands.Length; i++) bands[i] = Math.Max(bands[i], next.Bands[i]);
            energy += (double)next.Level * next.Level;
            count++;
        }
        return new Spectrum(bands, count == 0 ? 0 : Normalize((float)Math.Sqrt(energy / count)));
    }

    private static void WatchInput()
    {
        try
        {
            using (System.IO.Stream input = Console.OpenStandardInput())
            {
                while (input.ReadByte() != -1) { }
            }
        }
        catch { }
        Interlocked.Exchange(ref stopRequested, 1);
    }

    private static bool SupportsProcessLoopback()
    {
        OsVersionInfo version = new OsVersionInfo();
        version.Size = (uint)Marshal.SizeOf(typeof(OsVersionInfo));
        if (RtlGetVersion(ref version) != 0) return false;
        return version.Major > 10 ||
            (version.Major == 10 && version.Minor == 0 && version.Build >= ProcessLoopbackMinimumBuild);
    }

    private static void ReadPackets(IAudioCaptureClient capture, SampleBuffer samples)
    {
        uint packetFrames;
        Check(capture.GetNextPacketSize(out packetFrames), "Could not read the Windows audio stream.");
        while (packetFrames > 0)
        {
            IntPtr data;
            uint frames;
            uint flags;
            ulong devicePosition;
            ulong qpcPosition;
            Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "Could not read Windows audio samples.");
            try
            {
                if (frames > 384000) throw new InvalidOperationException("Windows returned an oversized audio packet.");
                byte[] bytes = new byte[checked((int)frames * samples.BlockAlign)];
                if ((flags & SilentFlag) == 0 && bytes.Length > 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                else if (samples.IsUnsignedPcm && bytes.Length > 0) for (int i = 0; i < bytes.Length; i++) bytes[i] = 128;
                samples.Append(bytes, (int)frames);
            }
            finally
            {
                Check(capture.ReleaseBuffer(frames), "Could not release the Windows audio packet.");
            }
            Check(capture.GetNextPacketSize(out packetFrames), "Could not read the Windows audio stream.");
        }
    }

    private static int SelfTest()
    {
        float[] silence = new float[SampleCount];
        Spectrum silent = new Analyzer().Analyze(new float[][] { silence }, 48000);
        if (silent.Level != 0 || !AllZero(silent.Bands))
        {
            EmitError("Windows audio helper self-test failed: silence.");
            return 1;
        }
        float[] sine = new float[SampleCount];
        double frequency = 984.375;
        for (int i = 0; i < SampleCount; i++) sine[i] = (float)Math.Sin(2 * Math.PI * frequency * i / 48000);
        Spectrum result = new Analyzer().Analyze(new float[][] { sine }, 48000);
        if (result.Bands[12] < 0.9f || result.Level < 0.69f || result.Level > 0.72f)
        {
            EmitError("Windows audio helper self-test failed: sine spectrum.");
            return 1;
        }
        Console.WriteLine("{\"type\":\"self-test\",\"ok\":true}");
        return 0;
    }

    private static bool AllZero(float[] values)
    {
        for (int i = 0; i < values.Length; i++) if (values[i] != 0) return false;
        return true;
    }

    private static void EmitFrame(Spectrum spectrum)
    {
        StringBuilder json = new StringBuilder("{\"type\":\"frame\",\"bands\":[");
        for (int i = 0; i < spectrum.Bands.Length; i++)
        {
            if (i > 0) json.Append(',');
            json.Append(spectrum.Bands[i].ToString("R", CultureInfo.InvariantCulture));
        }
        json.Append("],\"level\":").Append(spectrum.Level.ToString("R", CultureInfo.InvariantCulture)).Append('}');
        Console.WriteLine(json.ToString());
        Console.Out.Flush();
    }

    private static void EmitError(string message)
    {
        if (message == null) message = "Windows audio capture failed.";
        if (message.Length > 400) message = message.Substring(0, 400);
        StringBuilder escaped = new StringBuilder();
        foreach (char character in message)
        {
            if (character == '\\' || character == '"') escaped.Append('\\').Append(character);
            else if (character == '\r') escaped.Append("\\r");
            else if (character == '\n') escaped.Append("\\n");
            else if (character < 32) escaped.Append(' ');
            else escaped.Append(character);
        }
        Console.WriteLine("{\"type\":\"error\",\"message\":\"" + escaped.ToString() + "\"}");
        Console.Out.Flush();
    }

    private static void Check(int result, string message)
    {
        if (result < 0) throw new InvalidOperationException(message + " (Windows audio error 0x" + result.ToString("X8") + ").");
    }

    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value))
        {
            try { Marshal.ReleaseComObject(value); } catch { }
        }
    }

    private sealed class SampleBuffer
    {
        private readonly WaveFormat format;
        private readonly float[,] data = new float[2, SampleCount];
        private int cursor;
        private int available;
        public int BlockAlign { get { return format.BlockAlign; } }
        public bool IsUnsignedPcm { get { return format.IsPcm && format.Bits == 8; } }

        public SampleBuffer(WaveFormat format) { this.format = format; }

        public void Append(byte[] bytes, int frames)
        {
            int channels = Math.Min(2, (int)format.Channels);
            for (int frame = 0; frame < frames; frame++)
            {
                for (int channel = 0; channel < channels; channel++)
                {
                    int offset = frame * format.BlockAlign + channel * format.BytesPerSample;
                    data[channel, cursor] = Decode(bytes, offset, format);
                }
                cursor = (cursor + 1) % SampleCount;
                available = Math.Min(SampleCount, available + 1);
            }
        }

        public float[][] Snapshot()
        {
            int channels = Math.Min(2, (int)format.Channels);
            float[][] result = new float[channels][];
            for (int channel = 0; channel < channels; channel++)
            {
                result[channel] = new float[SampleCount];
                for (int i = 0; i < available; i++)
                    result[channel][SampleCount - available + i] = data[channel, (cursor - available + i + SampleCount) % SampleCount];
            }
            return result;
        }

        private static float Decode(byte[] bytes, int offset, WaveFormat format)
        {
            if (format.IsFloat) return BitConverter.ToSingle(bytes, offset);
            long sample;
            if (format.Bits == 8) sample = bytes[offset] - 128;
            else if (format.Bits == 16) sample = BitConverter.ToInt16(bytes, offset);
            else if (format.Bits == 24)
            {
                sample = bytes[offset] | ((long)bytes[offset + 1] << 8) | ((long)bytes[offset + 2] << 16);
                if ((sample & 0x800000) != 0) sample |= unchecked((long)0xffffffffff000000);
            }
            else sample = BitConverter.ToInt32(bytes, offset);
            if (format.ValidBits > 0 && format.ValidBits < format.Bits) sample >>= format.Bits - format.ValidBits;
            int validBits = format.ValidBits > 0 ? format.ValidBits : format.Bits;
            return (float)(sample / Math.Pow(2, validBits - 1));
        }
    }

    private sealed class WaveFormat
    {
        public ushort Channels;
        public uint SampleRate;
        public ushort BlockAlign;
        public ushort Bits;
        public ushort ValidBits;
        public ushort FormatTag;
        public int BytesPerSample { get { return Bits / 8; } }
        public bool IsFloat { get; private set; }
        public bool IsPcm { get; private set; }

        public static WaveFormat Read(IntPtr pointer)
        {
            WaveFormat value = new WaveFormat();
            value.FormatTag = unchecked((ushort)Marshal.ReadInt16(pointer, 0));
            value.Channels = unchecked((ushort)Marshal.ReadInt16(pointer, 2));
            value.SampleRate = unchecked((uint)Marshal.ReadInt32(pointer, 4));
            value.BlockAlign = unchecked((ushort)Marshal.ReadInt16(pointer, 12));
            value.Bits = unchecked((ushort)Marshal.ReadInt16(pointer, 14));
            value.ValidBits = value.Bits;
            if (value.FormatTag == 0xFFFE)
            {
                value.ValidBits = unchecked((ushort)Marshal.ReadInt16(pointer, 18));
                Guid subFormat = (Guid)Marshal.PtrToStructure(IntPtr.Add(pointer, 24), typeof(Guid));
                value.IsFloat = subFormat == new Guid("00000003-0000-0010-8000-00AA00389B71");
                value.IsPcm = subFormat == new Guid("00000001-0000-0010-8000-00AA00389B71");
            }
            else
            {
                value.IsFloat = value.FormatTag == 3;
                value.IsPcm = value.FormatTag == 1;
            }
            return value;
        }
    }

    private sealed class Analyzer
    {
        public Spectrum Analyze(float[][] channels, double sampleRate)
        {
            float[] bands = new float[BandCount];
            if (channels == null || channels.Length == 0 || !IsFinite(sampleRate) || sampleRate <= 90)
                return new Spectrum(bands, 0);
            double energy = 0;
            double upper = Math.Min(16000, sampleRate / 2);
            double ratio = upper / 45;
            for (int channel = 0; channel < channels.Length; channel++)
            {
                double channelEnergy = 0;
                double[] real = new double[SampleCount];
                double[] imaginary = new double[SampleCount];
                for (int i = 0; i < SampleCount; i++)
                {
                    float sample = channels[channel][i];
                    if (!IsFinite(sample)) sample = 0;
                    channelEnergy += (double)sample * sample;
                    double window = 0.5 * (1 - Math.Cos(2 * Math.PI * i / SampleCount));
                    real[i] = sample * window;
                }
                energy += channelEnergy;
                if (channelEnergy == 0) continue;
                Transform(real, imaginary);
                for (int bin = 1; bin < SampleCount / 2; bin++)
                {
                    double frequency = bin * sampleRate / SampleCount;
                    if (frequency < 45 || frequency >= upper) continue;
                    int band = Math.Min(BandCount - 1, (int)(Math.Log(frequency / 45) / Math.Log(ratio) * BandCount));
                    float amplitude = (float)(Math.Sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) * 4 / SampleCount);
                    bands[band] = Math.Max(bands[band], VisualLevel(amplitude));
                }
            }
            float level = Normalize((float)Math.Sqrt(energy / (SampleCount * channels.Length)));
            return new Spectrum(bands, level);
        }

        private static void Transform(double[] real, double[] imaginary)
        {
            int j = 0;
            for (int i = 1; i < SampleCount; i++)
            {
                int bit = SampleCount >> 1;
                while ((j & bit) != 0) { j ^= bit; bit >>= 1; }
                j ^= bit;
                if (i < j)
                {
                    double temp = real[i]; real[i] = real[j]; real[j] = temp;
                    temp = imaginary[i]; imaginary[i] = imaginary[j]; imaginary[j] = temp;
                }
            }
            for (int length = 2; length <= SampleCount; length <<= 1)
            {
                double angle = -2 * Math.PI / length;
                double stepReal = Math.Cos(angle);
                double stepImaginary = Math.Sin(angle);
                for (int offset = 0; offset < SampleCount; offset += length)
                {
                    double factorReal = 1;
                    double factorImaginary = 0;
                    for (int i = 0; i < length / 2; i++)
                    {
                        int even = offset + i;
                        int odd = even + length / 2;
                        double oddReal = real[odd] * factorReal - imaginary[odd] * factorImaginary;
                        double oddImaginary = real[odd] * factorImaginary + imaginary[odd] * factorReal;
                        real[odd] = real[even] - oddReal;
                        imaginary[odd] = imaginary[even] - oddImaginary;
                        real[even] += oddReal;
                        imaginary[even] += oddImaginary;
                        double nextReal = factorReal * stepReal - factorImaginary * stepImaginary;
                        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal;
                        factorReal = nextReal;
                    }
                }
            }
        }
    }

    private sealed class Spectrum
    {
        public readonly float[] Bands;
        public readonly float Level;
        public Spectrum(float[] bands, float level) { Bands = bands; Level = level; }
    }

    private static float Normalize(float value)
    {
        return IsFinite(value) ? (float)Math.Max(0, Math.Min(1, value)) : 0;
    }

    private static float VisualLevel(float amplitude)
    {
        if (!IsFinite(amplitude) || amplitude <= 0.00031623f) return 0;
        return Normalize((float)((20 * Math.Log10(amplitude) + 70) / 70));
    }

    private static bool IsFinite(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value); }

    private sealed class AudioStream : IDisposable
    {
        public readonly IAudioClient Client;
        public readonly IAudioCaptureClient Capture;
        public readonly SampleBuffer Samples;
        public readonly WaveFormat Format;
        private readonly IntPtr formatPointer;

        public AudioStream(IAudioClient client, IAudioCaptureClient capture, IntPtr formatPointer, WaveFormat format)
        {
            Client = client;
            Capture = capture;
            this.formatPointer = formatPointer;
            Format = format;
            Samples = new SampleBuffer(format);
        }

        public void Dispose()
        {
            try { Client.Stop(); } catch { }
            if (formatPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(formatPointer);
            Release(Capture);
            Release(Client);
        }
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IDisposable
    {
        private const int Failure = unchecked((int)0x80004005);
        public readonly System.Threading.ManualResetEvent Completed = new System.Threading.ManualResetEvent(false);
        public IAudioClient Client;
        public int Result = unchecked((int)0x8000FFFF);

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            object activated = null;
            try
            {
                int activationResult;
                int result = operation.GetActivateResult(out activationResult, out activated);
                Result = result < 0 ? result : activationResult;
                if (Result >= 0)
                {
                    Client = activated as IAudioClient;
                    if (Client == null)
                        Result = unchecked((int)0x80004002);
                }
            }
            catch { Result = Failure; }
            finally
            {
                if (Client == null) Release(activated);
                Completed.Set();
            }
            return 0;
        }

        public void Dispose() { Completed.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort Vt;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public uint BlobSize;
        public IntPtr BlobData;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OsVersionInfo
    {
        public uint Size;
        public uint Major;
        public uint Minor;
        public uint Build;
        public uint PlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activationResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, [MarshalAs(UnmanagedType.Interface)] out object devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid interfaceId, int classContext, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, int flags, long duration, long periodicity, IntPtr format, ref Guid session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(string deviceInterfacePath, ref Guid interfaceId, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("ntdll.dll")]
    private static extern int RtlGetVersion(ref OsVersionInfo version);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
