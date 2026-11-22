$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false

try {
    $source = Join-Path $PSScriptRoot 'SpotifyAudioHelper.Windows.cs'
    $code = Get-Content -Raw -LiteralPath $source
    $loaded = $false
    try {
        # Compile once per source version and reuse the assembly; any failure falls back to in-memory compilation.
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
        $root = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [IO.Path]::GetTempPath() }
        $dir = Join-Path $root 'pokemon-agents-audio'
        $dll = Join-Path $dir "helper-$hash.dll"
        if (-not (Test-Path -LiteralPath $dll)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $temp = Join-Path $dir ("helper-$hash-" + [Guid]::NewGuid().ToString('N') + '.tmp.dll')
            Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $temp
            Move-Item -LiteralPath $temp -Destination $dll -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
        }
        Add-Type -Path $dll
        $loaded = $true
    } catch { [Console]::Error.WriteLine('Audio helper cache unavailable: ' + $_.Exception.Message) }
    if (-not $loaded) { Add-Type -TypeDefinition $code -Language CSharp }
    $result = [SpotifyAudioHelper]::Run([string[]]$args)
    exit $result
}
catch {
    $detail = $_.Exception.Message
    if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
    $message = @{ type = 'error'; message = $detail } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($message)
    exit 1
}
