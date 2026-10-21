param(
    [ValidateSet('Run', 'Develop')][string]$Mode = 'Run',
    [switch]$NoOpen,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'

try {
    $replayRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $replayLaunch = Join-Path $PSScriptRoot 'launch.mjs'
    $replayNode = Join-Path $env:LOCALAPPDATA 'Programs\node-v24.21.0-win-x64\node.exe'
    if (-not (Test-Path -LiteralPath $replayNode -PathType Leaf)) {
        $replayNode = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $replayVersion = & $replayNode -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($replayVersion.Split('.')[0]) -lt 24) {
        throw 'Vela requires Node.js 24 or newer.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $replayRoot 'node_modules\vite\package.json') -PathType Leaf)) {
        throw 'Vela dependencies are missing. Run npm ci in the Vela folder first.'
    }
    if ($Check) {
        [pscustomobject]@{ Mode = $Mode; Node = $replayNode; Version = $replayVersion; Root = $replayRoot } | ConvertTo-Json -Compress
        return
    }
    $replayLogs = Join-Path $PSScriptRoot '.runtime\desktop-logs'
    [void][IO.Directory]::CreateDirectory($replayLogs)
    $replayAttempt = '{0}-{1}-{2}' -f $Mode.ToLowerInvariant(), (Get-Date -Format 'yyyyMMdd-HHmmss'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    $replayArguments = @(('"{0}"' -f $replayLaunch), '--mode', $Mode.ToLowerInvariant())
    if ($NoOpen) { $replayArguments += '--no-open' }
    $replayOutput = Join-Path $replayLogs "$replayAttempt.out.log"
    $replayErrors = Join-Path $replayLogs "$replayAttempt.err.log"
    $replayChild = Start-Process -FilePath $replayNode -ArgumentList $replayArguments -WorkingDirectory $replayRoot -WindowStyle Hidden -RedirectStandardOutput $replayOutput -RedirectStandardError $replayErrors -PassThru
    $replayChild.Id
    $replayPort = if ($Mode -eq 'Run') { 5197 } else { 5198 }
    $replayHasher = [Security.Cryptography.SHA256]::Create()
    try { $replayIdentity = ([BitConverter]::ToString($replayHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($replayRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() } finally { $replayHasher.Dispose() }
    $replayDeadline = [DateTime]::UtcNow.AddSeconds(180)
    while ([DateTime]::UtcNow -lt $replayDeadline) {
        if ($replayChild.HasExited) {
            $replayChild.WaitForExit()
            if ($replayChild.ExitCode -ne 0) { throw "The local launcher exited. Details: $replayErrors" }
            break
        }
        try {
            $replayHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$replayPort/api/runtime" -TimeoutSec 1
            if ($replayHealth.managed -eq $true -and $replayHealth.mode -eq $Mode.ToLowerInvariant() -and $replayHealth.repositoryId -eq $replayIdentity -and $replayHealth.phase -eq 'ready') { break }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
} catch {
    if ($Check -or $NoOpen) { throw }
    Add-Type -AssemblyName PresentationFramework
    [void][Windows.MessageBox]::Show("Vela could not start. $($_.Exception.Message)", 'Vela', 'OK', 'Error')
    exit 1
}
