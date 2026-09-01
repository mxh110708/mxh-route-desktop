param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$BaseVersion = "",
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$dashboardRoot = Join-Path $desktopRoot "dashboard"
$coreRoot = Resolve-Path (Join-Path $desktopRoot "..\sing-box")

function Invoke-Git {
    param([string]$WorkingDirectory, [string[]]$Arguments)
    $proxyArguments = @()
    if (-not [string]::IsNullOrWhiteSpace($Proxy)) {
        $proxyArguments = @("-c", "http.proxy=$Proxy")
    }
    & git -C $WorkingDirectory @proxyArguments @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git failed in $WorkingDirectory"
    }
}

foreach ($workingDirectory in @($desktopRoot, $dashboardRoot, $coreRoot)) {
    $status = & git -C $workingDirectory status --porcelain
    if ($LASTEXITCODE -ne 0 -or $status) {
        throw "The working tree must be clean: $workingDirectory"
    }
}

Invoke-Git $dashboardRoot @("fetch", "upstream", "main", "--prune")
Invoke-Git $desktopRoot @("-c", "fetch.recurseSubmodules=false", "fetch", "upstream", "main", "--prune")
Invoke-Git $coreRoot @("fetch", "--no-tags", "upstream", "refs/tags/v${Version}:refs/tags/v${Version}")
if (-not [string]::IsNullOrWhiteSpace($BaseVersion)) {
    Invoke-Git $coreRoot @("fetch", "--no-tags", "upstream", "refs/tags/v${BaseVersion}:refs/tags/v${BaseVersion}")
}

Invoke-Git $desktopRoot @("switch", "--no-recurse-submodules", "custom-main")
Invoke-Git $desktopRoot @("rebase", "upstream/main")
Invoke-Git $dashboardRoot @("switch", "custom-main")
Invoke-Git $dashboardRoot @("rebase", "upstream/main")
Invoke-Git $coreRoot @("switch", "custom-main")
if ([string]::IsNullOrWhiteSpace($BaseVersion)) {
    Invoke-Git $coreRoot @("rebase", "v$Version")
} else {
    Invoke-Git $coreRoot @("rebase", "--onto", "v$Version", "v$BaseVersion", "custom-main")
}

Invoke-Git $desktopRoot @("add", "dashboard")
$dashboardPointerChanged = & git -C $desktopRoot diff --cached --quiet -- dashboard
if ($LASTEXITCODE -eq 1) {
    Invoke-Git $desktopRoot @("commit", "-m", "dashboard: replay custom changes on upstream")
} elseif ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the dashboard submodule pointer."
}

$expectedVersion = (Get-Content -LiteralPath (Join-Path $desktopRoot "version.json") -Raw | ConvertFrom-Json).version
if ($expectedVersion -ne $Version) {
    throw "Upstream desktop version is $expectedVersion, not $Version."
}

Write-Host "Upstream replay completed. Force-push with lease only after the full test and signed package workflow succeeds."
