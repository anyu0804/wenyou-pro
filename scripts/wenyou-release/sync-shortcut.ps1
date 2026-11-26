param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Read", "Sync", "Write")]
    [string]$Mode,

    [string]$ShortcutPath = "",
    [string]$TargetExe = "",
    [string]$WorkingDir = "",
    [string]$IconLocation = "",
    [string]$Description = "",
    [string]$Arguments = "",
    [string]$ArgumentsBase64 = "",
    [switch]$UseEnv,
    [switch]$RefreshShell
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$script:ShellNotifyCSharpSource = @'
using System;
using System.Runtime.InteropServices;

public static class WenyouShellNotifyNative {
    [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@

function Invoke-ShellRefresh {
    try {
        if (-not ("WenyouShellNotifyNative" -as [type])) {
            Add-Type -TypeDefinition $script:ShellNotifyCSharpSource -ErrorAction Stop | Out-Null
        }
        [WenyouShellNotifyNative]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
        return $true
    } catch {
        return $false
    }
}

function ConvertTo-SafeString {
    param([object]$Value)
    if ($null -eq $Value) {
        return ""
    }
    return [string]$Value
}

function Get-EnvString {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )
    $val = [System.Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $val) {
        return ""
    }
    return [string]$val
}

if ($UseEnv) {
    $ShortcutPath = Get-EnvString "WENYOU_SHORTCUT_PATH"
    $TargetExe = Get-EnvString "WENYOU_TARGET_EXE"
    $WorkingDir = Get-EnvString "WENYOU_WORKING_DIR"
    $IconLocation = Get-EnvString "WENYOU_ICON_LOCATION"
    $Description = Get-EnvString "WENYOU_DESCRIPTION"
    $Arguments = Get-EnvString "WENYOU_ARGUMENTS"
    $ArgumentsBase64 = Get-EnvString "WENYOU_ARGUMENTS_B64"
}

function Read-ShortcutObject {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResolvedPath
    )

    if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
        return [ordered]@{
            shortcutPath     = $ResolvedPath
            exists           = $false
            targetPath       = ""
            arguments        = ""
            workingDirectory = ""
            iconLocation     = ""
            description      = ""
        }
    }

    $inspectPath = $ResolvedPath
    $tempCopyPath = $null
    if (-not $ResolvedPath.EndsWith(".lnk", [System.StringComparison]::OrdinalIgnoreCase)) {
        $tempCopyPath = Join-Path ([System.IO.Path]::GetTempPath()) ("wenyou-lnk-read-" + [Guid]::NewGuid().ToString("N") + ".lnk")
        [System.IO.File]::Copy($ResolvedPath, $tempCopyPath, $true)
        $inspectPath = $tempCopyPath
    }

    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($inspectPath)
        return [ordered]@{
            shortcutPath     = $ResolvedPath
            exists           = $true
            targetPath       = ConvertTo-SafeString $shortcut.TargetPath
            arguments        = ConvertTo-SafeString $shortcut.Arguments
            workingDirectory = ConvertTo-SafeString $shortcut.WorkingDirectory
            iconLocation     = ConvertTo-SafeString $shortcut.IconLocation
            description      = ConvertTo-SafeString $shortcut.Description
        }
    } finally {
        if ($null -ne $shortcut) {
            try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) } catch {}
        }
        if ($null -ne $shell) {
            try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) } catch {}
        }
        if ($null -ne $tempCopyPath -and [System.IO.File]::Exists($tempCopyPath)) {
            try { [System.IO.File]::Delete($tempCopyPath) } catch {}
        }
    }
}

function Write-ShortcutObject {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResolvedShortcutPath,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedTargetExe,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedWorkingDir,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedIconLocation,

        [AllowEmptyString()]
        [string]$ShortcutDescription,

        [AllowEmptyString()]
        [string]$ShortcutArguments
    )

    $parentDir = [System.IO.Path]::GetDirectoryName($ResolvedShortcutPath)
    if (-not [string]::IsNullOrWhiteSpace($parentDir) -and -not (Test-Path -LiteralPath $parentDir -PathType Container)) {
        [void][System.IO.Directory]::CreateDirectory($parentDir)
    }

    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($ResolvedShortcutPath)
        $shortcut.TargetPath = $ResolvedTargetExe
        $shortcut.Arguments = $ShortcutArguments
        $shortcut.WorkingDirectory = $ResolvedWorkingDir
        $shortcut.IconLocation = $ResolvedIconLocation
        $shortcut.Description = $ShortcutDescription
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) } catch {}
        }
        if ($null -ne $shell) {
            try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) } catch {}
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    throw "ShortcutPath must not be empty."
}

$resolvedShortcutPath = [System.IO.Path]::GetFullPath($ShortcutPath)

if ($Mode -eq "Read") {
    $result = Read-ShortcutObject -ResolvedPath $resolvedShortcutPath
    Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
    exit 0
}

if (-not $resolvedShortcutPath.EndsWith(".lnk", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ShortcutPath must end with .lnk in $Mode mode."
}

if ([string]::IsNullOrWhiteSpace($TargetExe)) {
    throw "TargetExe is required in $Mode mode."
}

$resolvedTargetExe = [System.IO.Path]::GetFullPath($TargetExe)
$effectiveArguments = ""

if ($Mode -eq "Sync") {
    if ($Arguments.Length -gt 0 -or $ArgumentsBase64.Length -gt 0) {
        throw "Mode Sync does not allow non-empty Arguments."
    }
    if (-not (Test-Path -LiteralPath $resolvedTargetExe -PathType Leaf)) {
        throw "Target executable does not exist or is not a file."
    }
    $effectiveArguments = ""
} else {
    if ($ArgumentsBase64.Length -gt 0) {
        $argBytes = [System.Convert]::FromBase64String($ArgumentsBase64)
        $effectiveArguments = [System.Text.Encoding]::UTF8.GetString($argBytes)
    } else {
        $effectiveArguments = $Arguments
    }
}

$resolvedWorkingDir = if ([string]::IsNullOrWhiteSpace($WorkingDir)) {
    [System.IO.Path]::GetDirectoryName($resolvedTargetExe)
} else {
    [System.IO.Path]::GetFullPath($WorkingDir)
}

$resolvedIconLocation = if ([string]::IsNullOrWhiteSpace($IconLocation)) {
    "$resolvedTargetExe,0"
} else {
    $IconLocation
}

Write-ShortcutObject `
    -ResolvedShortcutPath $resolvedShortcutPath `
    -ResolvedTargetExe $resolvedTargetExe `
    -ResolvedWorkingDir $resolvedWorkingDir `
    -ResolvedIconLocation $resolvedIconLocation `
    -ShortcutDescription $Description `
    -ShortcutArguments $effectiveArguments

$shellRefreshed = $false
if ($Mode -eq "Sync" -and $RefreshShell) {
    $shellRefreshed = Invoke-ShellRefresh
}

$readback = Read-ShortcutObject -ResolvedPath $resolvedShortcutPath
if ($Mode -eq "Sync") {
    $readback["shellRefreshed"] = [bool]$shellRefreshed
}
Write-Output ($readback | ConvertTo-Json -Depth 4 -Compress)
