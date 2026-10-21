param([switch]$Check)
$ErrorActionPreference = 'Stop'
$replayRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$replayDesktop = [Environment]::GetFolderPath('Desktop')
$replayShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$replayWrapper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'desktop.ps1')).Path
if (-not [IO.Directory]::Exists($replayDesktop)) { throw 'The Windows Desktop folder is unavailable.' }
$replayWsh = New-Object -ComObject WScript.Shell
$replayEdge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
$replayInstalled = Join-Path $env:LOCALAPPDATA 'Programs\Vela\Vela.exe'

foreach ($replayMode in @('Run', 'Develop')) {
    $replayShortcutPath = Join-Path $replayDesktop "$replayMode Vela.lnk"
    $replayArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1}' -f $replayWrapper, $replayMode
    $replayLink = $replayWsh.CreateShortcut($replayShortcutPath)
    $replayOwned = ($replayLink.TargetPath -eq $replayShell -and $replayLink.Arguments -like "*$replayWrapper*") -or ($replayMode -eq 'Run' -and $replayLink.TargetPath -eq $replayInstalled)
    if ([IO.File]::Exists($replayShortcutPath) -and -not $replayOwned) {
        throw "A different shortcut already uses $replayShortcutPath. It was preserved."
    }
    if (-not $Check) {
        $replayLink.TargetPath = $replayShell
        $replayLink.Arguments = $replayArguments
        $replayLink.WorkingDirectory = $replayRoot
        $replayLink.WindowStyle = 7
        $replayLink.Description = if ($replayMode -eq 'Run') { 'Open the optimized local Vela app and watch for code updates.' } else { 'Open Vela development mode with coordinated code reloads.' }
        $replayLink.IconLocation = if ($replayMode -eq 'Run' -and [IO.File]::Exists($replayEdge)) { "$replayEdge,0" } else { "$replayShell,0" }
        if ($replayMode -eq 'Run' -and [IO.File]::Exists($replayInstalled)) {
            $replayLink.TargetPath = $replayInstalled
            $replayLink.Arguments = ''
            $replayLink.WorkingDirectory = Split-Path -Parent $replayInstalled
            $replayLink.IconLocation = "$replayInstalled,0"
            $replayLink.Description = 'Open installed Vela with saved-workspace updates from your fork.'
        }
        $replayLink.Save()
    }
    [pscustomobject]@{ Shortcut = $replayShortcutPath; Exists = [IO.File]::Exists($replayShortcutPath); Target = $replayLink.TargetPath; Arguments = $replayLink.Arguments; WorkingDirectory = $replayLink.WorkingDirectory }
}
