$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$preflightScript = Join-Path $repositoryRoot "build\installer-preflight.ps1"
. $preflightScript -InstallationDirectory $repositoryRoot

function Assert-Equal([object]$Expected, [object]$Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message Expected '$Expected', received '$Actual'."
    }
}

function Assert-ThrowsLike(
    [scriptblock]$Action,
    [string]$ExpectedMessage,
    [string]$Message
) {
    try {
        & $Action
    } catch {
        if ($_.Exception.Message -notlike "*$ExpectedMessage*") {
            throw "$Message Unexpected error: $($_.Exception.Message)"
        }
        return
    }
    throw "$Message The action did not throw."
}

function New-TestDirectory([string]$Name) {
    $path = Join-Path $testRoot $Name
    [void][System.IO.Directory]::CreateDirectory($path)
    return $path
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryRoot "mxh-route-installer-$([Guid]::NewGuid().ToString('N'))"
[void][System.IO.Directory]::CreateDirectory($testRoot)

try {
    $newID = [Guid]::NewGuid().ToString("B")
    $oldID = [Guid]::NewGuid().ToString("B")

    $missingDirectory = Join-Path $testRoot "missing"
    Assert-Equal `
        "Initialize" `
        (Get-ApplicationDataDirectoryInitializationAction $missingDirectory $newID $false) `
        "A missing data directory should be initialized."

    $emptyDirectory = New-TestDirectory "empty"
    Assert-Equal `
        "Initialize" `
        (Get-ApplicationDataDirectoryInitializationAction $emptyDirectory $newID $false) `
        "An empty data directory should be initialized."

    $matchingDirectory = New-TestDirectory "matching"
    [System.IO.File]::WriteAllText((Join-Path $matchingDirectory "settings.db"), "test")
    [Box.Installer.DirectoryAccessControl]::WriteDirectoryMarker($matchingDirectory, $newID)
    Assert-Equal `
        "Reuse" `
        (Get-ApplicationDataDirectoryInitializationAction $matchingDirectory $newID $false) `
        "A data directory owned by the current installation should be reused."

    $orphanedDirectory = New-TestDirectory "orphaned"
    [System.IO.File]::WriteAllText((Join-Path $orphanedDirectory "settings.db"), "test")
    [Box.Installer.DirectoryAccessControl]::WriteDirectoryMarker($orphanedDirectory, $oldID)
    Assert-ThrowsLike `
        { Get-ApplicationDataDirectoryInitializationAction $orphanedDirectory $newID $false } `
        "must be empty" `
        "Normal upgrades must not adopt a mismatched data directory."
    Assert-Equal `
        "Adopt" `
        (Get-ApplicationDataDirectoryInitializationAction $orphanedDirectory $newID $true) `
        "A fresh install should recover a marked orphaned data directory."

    $unmarkedDirectory = New-TestDirectory "unmarked"
    [System.IO.File]::WriteAllText((Join-Path $unmarkedDirectory "settings.db"), "test")
    Assert-ThrowsLike `
        { Get-ApplicationDataDirectoryInitializationAction $unmarkedDirectory $newID $true } `
        "must be empty" `
        "A non-empty unmarked data directory must be rejected."

    $invalidMarkerDirectory = New-TestDirectory "invalid-marker"
    [System.IO.File]::WriteAllText((Join-Path $invalidMarkerDirectory "settings.db"), "test")
    [Box.Installer.DirectoryAccessControl]::WriteDirectoryMarker(
        $invalidMarkerDirectory,
        "invalid-installation-id"
    )
    Assert-ThrowsLike `
        { Get-ApplicationDataDirectoryInitializationAction $invalidMarkerDirectory $newID $true } `
        "must be empty" `
        "A non-empty directory with an invalid marker must be rejected."

    $junctionTarget = New-TestDirectory "junction-target"
    $junctionDirectory = Join-Path $testRoot "junction"
    [void](New-Item -ItemType Junction -Path $junctionDirectory -Target $junctionTarget)
    Assert-ThrowsLike `
        { Get-ApplicationDataDirectoryInitializationAction $junctionDirectory $newID $true } `
        "is invalid" `
        "A reparse-point data directory must be rejected."

    Write-Output "Installer application-data recovery tests passed."
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith(
            $temporaryRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing to remove a test directory outside the temporary root."
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
