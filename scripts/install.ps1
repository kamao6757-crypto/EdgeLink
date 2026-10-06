param([string]$ExtensionId = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hostExe = Join-Path $projectRoot 'native\EdgeLink.Host.exe'
$coreExe = Join-Path $projectRoot 'native\bin\mihomo.exe'
$manifestPath = Join-Path $projectRoot 'native\com.edgelink.mihomo.json'
if (-not (Test-Path -LiteralPath $hostExe) -or -not (Test-Path -LiteralPath $coreExe)) {
    throw 'The native host or Mihomo executable is missing. Extract the whole package first.'
}
if (-not $ExtensionId) { $ExtensionId = (Get-Content -LiteralPath (Join-Path $projectRoot 'native\extension-id.txt') -Raw).Trim() }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid Edge extension ID.' }
$manifest = @{
    name = 'com.edgelink.mihomo'
    description = 'EdgeLink independent Mihomo core host'
    path = $hostExe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
$keyPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.edgelink.mihomo'
$previous = $null
if (Test-Path -LiteralPath $keyPath) { $previous = (Get-Item -LiteralPath $keyPath).GetValue('') }
$recordPath = Join-Path $projectRoot 'native\registration-backup.json'
if (-not (Test-Path -LiteralPath $recordPath)) {
    [System.IO.File]::WriteAllText($recordPath, (@{ previous = $previous; installed = $manifestPath } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}
New-Item -Path $keyPath -Force | Out-Null
Set-Item -LiteralPath $keyPath -Value $manifestPath
Write-Host "Native helper installed for the current Windows user. No administrator permission needed."
Write-Host "Extension ID: $ExtensionId"
Write-Host "Load this folder in edge://extensions : $(Join-Path $projectRoot 'extension')"
Write-Host 'No core has been started and no system proxy has been changed.'
