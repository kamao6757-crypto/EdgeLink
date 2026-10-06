[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourcePath = Join-Path $projectRoot 'native\Installer.cs'
if ([string]::IsNullOrWhiteSpace($PackagePath)) { $PackagePath = Join-Path $projectRoot 'dist\EdgeLink-v0.1.3-win-x64.zip' }
elseif (-not [System.IO.Path]::IsPathRooted($PackagePath)) { $PackagePath = Join-Path $projectRoot $PackagePath }
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $projectRoot 'dist\EdgeLink-Setup-v0.1.3-win-x64.exe' }
elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $projectRoot $OutputPath }
$PackagePath = [System.IO.Path]::GetFullPath($PackagePath)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw 'Offline ZIP package is missing. Build the versioned ZIP first.' }
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Installer.cs source is missing.' }
$frameworkRoot = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'csc.exe') -PathType Leaf } | Select-Object -First 1
if (-not $frameworkRoot) { throw 'Windows .NET Framework C# compiler was not found.' }
$outputDirectory = [System.IO.Path]::GetDirectoryName($OutputPath)
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$manifestDirectory = Join-Path $projectRoot 'output\diagnostics\installer-build'
New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null
$manifestPath = Join-Path $manifestDirectory 'asInvoker.manifest'
$manifestText = @'
<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="0.1.3.0" name="EdgeLink.Offline.Setup" />
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges></security>
  </trustInfo>
</assembly>
'@
[System.IO.File]::WriteAllText($manifestPath, $manifestText, (New-Object System.Text.UTF8Encoding($false)))
$compilerArguments = @(
    '/nologo', '/utf8output', '/target:winexe', '/platform:anycpu', '/langversion:5', '/optimize+', '/debug-',
    "/out:$OutputPath", "/win32manifest:$manifestPath", "/resource:$PackagePath,payload.zip",
    "/reference:$(Join-Path $frameworkRoot 'System.Windows.Forms.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.Drawing.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.IO.Compression.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.IO.Compression.FileSystem.dll')",
    "/reference:$(Join-Path $frameworkRoot 'System.Web.Extensions.dll')",
    $sourcePath
)
& (Join-Path $frameworkRoot 'csc.exe') @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed with exit code $LASTEXITCODE." }
$installerHash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(($OutputPath + '.sha256'), ($installerHash + '  ' + [System.IO.Path]::GetFileName($OutputPath) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Offline installer built: $OutputPath"
Write-Output "SHA256: $installerHash"
Write-Output 'The ZIP is embedded in the EXE. Building does not install, register, download, or start a core.'
