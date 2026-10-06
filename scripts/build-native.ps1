[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'native'
$usesDefaultOutput = [string]::IsNullOrWhiteSpace($OutputPath)
$defaultOutputPath = [System.IO.Path]::GetFullPath((Join-Path $nativeRoot 'EdgeLink.Host.exe'))
$stagedOutputPath = [System.IO.Path]::GetFullPath((Join-Path $nativeRoot 'EdgeLink.Host.next.exe'))
$resolvedSourcePath = if ([string]::IsNullOrWhiteSpace($SourcePath)) { Join-Path $nativeRoot 'Host.cs' } elseif ([System.IO.Path]::IsPathRooted($SourcePath)) { $SourcePath } else { Join-Path $projectRoot $SourcePath }
$resolvedOutputPath = if ($usesDefaultOutput) { $defaultOutputPath } elseif ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $projectRoot $OutputPath }
$resolvedSourcePath = [System.IO.Path]::GetFullPath($resolvedSourcePath)
$resolvedOutputPath = [System.IO.Path]::GetFullPath($resolvedOutputPath)
$frameworkCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$frameworkRoot = $frameworkCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'csc.exe') } | Select-Object -First 1
if (-not $frameworkRoot) {
    throw '找不到 Windows .NET Framework 4 C# 编译器，请启用 .NET Framework 4.8 后重试。'
}
if (-not (Test-Path -LiteralPath $resolvedSourcePath -PathType Leaf)) {
    throw "找不到宿主源文件：$resolvedSourcePath"
}

$compilerPath = Join-Path $frameworkRoot 'csc.exe'

function Test-OutputInUse([string]$PathToCheck) {
    if (-not (Test-Path -LiteralPath $PathToCheck -PathType Leaf)) { return $false }
    $probe = $null
    try {
        $probe = [System.IO.File]::Open($PathToCheck, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        return $false
    } catch [System.IO.IOException] {
        return $true
    } finally {
        if ($null -ne $probe) { $probe.Dispose() }
    }
}

function Invoke-HostCompilation([string]$DestinationPath) {
    $artifactDirectory = [System.IO.Path]::GetDirectoryName($DestinationPath)
    if (-not (Test-Path -LiteralPath $artifactDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
    }
    $compilerArguments = @(
        '/nologo', '/utf8output', '/target:exe', '/platform:anycpu', '/langversion:5', '/optimize+', '/debug-',
        "/out:$DestinationPath",
        "/reference:$(Join-Path $frameworkRoot 'System.Web.Extensions.dll')",
        "/reference:$(Join-Path $frameworkRoot 'System.Net.Http.dll')",
        $resolvedSourcePath
    )
    & $compilerPath @compilerArguments | Out-Host
    return $LASTEXITCODE
}

$staged = $false
if ($usesDefaultOutput -and (Test-OutputInUse $defaultOutputPath)) {
    $resolvedOutputPath = $stagedOutputPath
    $staged = $true
}
if (Test-OutputInUse $resolvedOutputPath) {
    throw '指定编译输出正在使用，请选择其他 -OutputPath；不会关闭现有宿主或覆盖运行文件。'
}
$compilerExitCode = Invoke-HostCompilation $resolvedOutputPath
if ($compilerExitCode -ne 0 -and $usesDefaultOutput -and -not $staged -and (Test-OutputInUse $defaultOutputPath)) {
    $resolvedOutputPath = $stagedOutputPath
    $staged = $true
    if (Test-OutputInUse $resolvedOutputPath) { throw '暂存宿主也正在使用，请选择其他 -OutputPath 后重试。' }
    $compilerExitCode = Invoke-HostCompilation $resolvedOutputPath
}
if ($compilerExitCode -ne 0) { throw "原生宿主编译失败，编译器退出码：$compilerExitCode" }
Write-Output "原生宿主已生成：$resolvedOutputPath"
if ($staged) {
    Write-Output '现有宿主正在运行，新版本已暂存为 EdgeLink.Host.next.exe。请关闭或重载扩展，确认宿主退出后通过安装流程替换正式文件；本脚本不会关闭进程或自动替换运行文件。'
}
