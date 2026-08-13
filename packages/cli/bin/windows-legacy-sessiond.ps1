$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class PixLegacySessiond {
    private const uint GENERIC_READ = 0x80000000;
    private const uint DELETE = 0x00010000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 0x102;
    private const uint FileDispositionInfo = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint LowDateTime; public uint HighDateTime; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint dwFileAttributes;
        public FILETIME ftCreationTime;
        public FILETIME ftLastAccessTime;
        public FILETIME ftLastWriteTime;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh;
        public uint nFileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, uint infoClass, ref FILE_DISPOSITION_INFO info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileSizeEx(SafeFileHandle file, out long size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long newPosition, uint moveMethod);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(SafeFileHandle file, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

    private static long FileTime(FILETIME value) { return ((long)value.HighDateTime << 32) | value.LowDateTime; }
    private static void Require(bool condition, string reason) { if (!condition) throw new InvalidOperationException(reason); }

    private static string ReadLock(SafeFileHandle handle) {
        long size;
        Require(GetFileSizeEx(handle, out size) && size > 0 && size <= 65536, "sessiond lock file size is invalid");
        long position;
        Require(SetFilePointerEx(handle, 0, out position, 0), "sessiond lock file could not be rewound");
        byte[] bytes = new byte[(int)size];
        uint read;
        Require(ReadFile(handle, bytes, (uint)bytes.Length, out read, IntPtr.Zero) && read == bytes.Length, "sessiond lock file could not be read");
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    private sealed class Input {
        public string endpoint { get; set; }
        public string lockFile { get; set; }
        public int expectedPid { get; set; }
        public string expectedInstanceId { get; set; }
        public string secret { get; set; }
        public int timeoutMs { get; set; }
    }

    private sealed class LockRecord {
        public int pid { get; set; }
        public string instanceId { get; set; }
        public long createdAt { get; set; }
    }

    private static string PipeName(string endpoint) {
        const string prefix = @"\\.\pipe\";
        Require(endpoint != null && endpoint.StartsWith(prefix, StringComparison.OrdinalIgnoreCase), "legacy endpoint is not a local Named Pipe");
        string name = endpoint.Substring(prefix.Length);
        Require(name.Length > 0 && name.IndexOf('\\') < 0 && name.IndexOf('/') < 0, "legacy endpoint name is invalid");
        return name;
    }

    private static string ReadLine(StreamReader reader, string reason) {
        string line = reader.ReadLine();
        Require(line != null, reason);
        return line;
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static string RpcRequest(string id, string method) {
        return Json.Serialize(new Dictionary<string, object> {
            { "protocolVersion", 1 }, { "id", id }, { "method", method }, { "params", new Dictionary<string, object>() }
        });
    }

    private static Dictionary<string, object> Rpc(StreamReader reader, StreamWriter writer, string id, string method) {
        string requestLine = RpcRequest(id, method);
        writer.WriteLine(requestLine);
        string responseLine = ReadLine(reader, "legacy sessiond closed the RPC pipe");
        Dictionary<string, object> root = Json.Deserialize<Dictionary<string, object>>(responseLine);
        Require(root != null && root.ContainsKey("id") && Convert.ToString(root["id"]) == id, "legacy sessiond RPC correlation failed");
        Require(root.ContainsKey("method") && Convert.ToString(root["method"]) == method, "legacy sessiond RPC method mismatch");
        Require(root.ContainsKey("ok") && root["ok"] is bool && (bool)root["ok"], "legacy sessiond rejected the identity RPC");
        Require(root.ContainsKey("result") && root["result"] is Dictionary<string, object>, "legacy sessiond RPC result is missing");
        return (Dictionary<string, object>)root["result"];
    }

    public static string Run(string inputJson) {
        Input input = Json.Deserialize<Input>(inputJson);
        Require(input != null, "helper input is invalid");
        Require(input.expectedPid > 0 && input.timeoutMs > 0 && input.timeoutMs <= 60000, "helper input bounds are invalid");
        Require(!String.IsNullOrEmpty(input.expectedInstanceId) && !String.IsNullOrEmpty(input.secret), "helper identity input is incomplete");

        using (SafeFileHandle lockHandle = CreateFileW(input.lockFile, GENERIC_READ | FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero)) {
            Require(!lockHandle.IsInvalid, "sessiond lock file could not be frozen");
            BY_HANDLE_FILE_INFORMATION lockInfo;
            Require(GetFileInformationByHandle(lockHandle, out lockInfo), "sessiond lock file metadata is unavailable");
            Require((lockInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0, "sessiond lock file is unsafe");
            LockRecord record = Json.Deserialize<LockRecord>(ReadLock(lockHandle));
            Require(record != null && record.pid == input.expectedPid && record.instanceId == input.expectedInstanceId && record.createdAt > 0, "sessiond lock identity changed");

            IntPtr process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)record.pid);
            Require(process != IntPtr.Zero, "sessiond process could not be opened");
            try {
                Require(GetProcessId(process) == (uint)record.pid, "sessiond process identity changed");
                FILETIME created, exited, kernel, user;
                Require(GetProcessTimes(process, out created, out exited, out kernel, out user), "sessiond process creation time is unavailable");
                long processCreatedMs = (FileTime(created) - 116444736000000000L) / 10000L;
                Require(processCreatedMs <= record.createdAt + 2000, "sessiond lock PID was reused");
                Require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "sessiond process already exited");

                using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName(input.endpoint), PipeDirection.InOut, PipeOptions.Asynchronous)) {
                    pipe.Connect(input.timeoutMs);
                    uint serverPid;
                    Require(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid), "legacy pipe server PID is unavailable");
                    Require(serverPid == (uint)record.pid && serverPid == GetProcessId(process), "legacy pipe server does not own the sessiond lock");
                    StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
                    StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true, NewLine = "\n" };
                    writer.WriteLine("AUTH " + input.secret);
                    Require(ReadLine(reader, "legacy sessiond closed during authentication") == "OK", "legacy sessiond authentication failed");
                    Dictionary<string, object> ping = Rpc(reader, writer, "ping", "system.ping");
                    Require(ping.ContainsKey("pong") && ping["pong"] is bool && (bool)ping["pong"], "legacy sessiond ping identity failed");
                    Dictionary<string, object> hello = Rpc(reader, writer, "hello", "system.hello");
                    Require(hello.ContainsKey("protocolVersion") && Convert.ToInt32(hello["protocolVersion"]) == 1, "legacy sessiond protocol identity failed");
                    Require(hello.ContainsKey("capabilities") && hello["capabilities"] is ArrayList, "legacy sessiond capability identity failed");
                    bool authority = false;
                    foreach (object capability in (ArrayList)hello["capabilities"]) if (Convert.ToString(capability) == "runtime.authority") authority = true;
                    Require(authority, "legacy endpoint is not a Pix runtime authority");
                    writer.Flush();
                    uint finalServerPid;
                    Require(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out finalServerPid) && finalServerPid == serverPid, "legacy pipe server identity changed");
                    Require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "sessiond process exited during verification");
                    Require(TerminateProcess(process, 0x50585801), "verified legacy sessiond termination failed");
                    Require(WaitForSingleObject(process, (uint)input.timeoutMs) == WAIT_OBJECT_0, "verified legacy sessiond did not exit");
                }

                FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
                Require(SetFileInformationByHandle(lockHandle, FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))), "verified legacy sessiond lock cleanup failed");
                return "{\"ok\":true,\"pid\":" + record.pid + "}";
            } finally {
                CloseHandle(process);
            }
        }
    }
}
'@

try {
    Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $source -Language CSharp
    $inputJson = [Console]::In.ReadToEnd()
    [Console]::Out.WriteLine([PixLegacySessiond]::Run($inputJson))
    exit 0
} catch {
    $reason = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    [Console]::Out.WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))
    exit 1
}
