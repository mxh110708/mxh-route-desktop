param(
    [Parameter(Mandatory = $true)]
    [string]$CertificateFile,
    [Parameter(Mandatory = $true)]
    [string]$CertificatePasswordFile,
    [string]$NodeExecutable = "node",
    [string]$GoExecutable = "go",
    [string]$PnpmScript
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $CertificateFile -PathType Leaf)) {
    throw "The local code-signing certificate is missing."
}
if (-not (Test-Path -LiteralPath $CertificatePasswordFile -PathType Leaf)) {
    throw "The local code-signing password file is missing."
}
if (-not (Get-Command $NodeExecutable -ErrorAction SilentlyContinue)) {
    throw "The requested Node.js executable is missing."
}
if (-not (Get-Command $GoExecutable -ErrorAction SilentlyContinue)) {
    throw "The requested Go executable is missing."
}

if ($PnpmScript) {
    if (-not (Test-Path -LiteralPath $PnpmScript -PathType Leaf)) {
        throw "The requested pnpm script is missing."
    }
} elseif (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
    throw "pnpm is missing. Pass -PnpmScript or install pnpm."
}

$resolvedNode = (Get-Command $NodeExecutable -ErrorAction Stop).Source
$resolvedGo = (Get-Command $GoExecutable -ErrorAction Stop).Source
$env:PATH = "$(Split-Path -Parent $resolvedNode);$(Split-Path -Parent $resolvedGo);$env:PATH"
$env:SING_BOX_CUSTOM_CERTIFICATE_FILE = $CertificateFile
$env:SING_BOX_CUSTOM_CERTIFICATE_PASSWORD_FILE = $CertificatePasswordFile

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    if ($PnpmScript) {
        & $resolvedNode $PnpmScript @Arguments
    } else {
        & pnpm @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repositoryRoot
try {
    Invoke-Pnpm test:update-source
    Invoke-Pnpm test:runtime-config
    Invoke-Pnpm test:custom-isolation
    Invoke-Pnpm typecheck
    Invoke-Pnpm @("-C", "dashboard", "test", "--", "--run")
    Invoke-Pnpm @("-C", "dashboard", "lint")
    Invoke-Pnpm @("-C", "dashboard", "lint:css")
    Invoke-Pnpm package:custom:win
} finally {
    Pop-Location
    Remove-Item Env:SING_BOX_CUSTOM_CERTIFICATE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:SING_BOX_CUSTOM_CERTIFICATE_PASSWORD_FILE -ErrorAction SilentlyContinue
}
