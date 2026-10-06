$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'native\com.edgelink.mihomo.json'
$keyPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.edgelink.mihomo'
if (Test-Path -LiteralPath $keyPath) {
    $current = (Get-Item -LiteralPath $keyPath).GetValue('')
    if ($current -eq $manifestPath) {
        $recordPath = Join-Path $projectRoot 'native\registration-backup.json'
        $previous = $null
        if (Test-Path -LiteralPath $recordPath) { $previous = (Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json).previous }
        if ($previous) { Set-Item -LiteralPath $keyPath -Value $previous }
        else { Remove-Item -LiteralPath $keyPath }
        Write-Host 'EdgeLink native helper registration removed.'
    } else { Write-Host 'Registration points to another installation; left unchanged.' }
}
Write-Host 'Disable the EdgeLink extension in Edge to release its browser proxy and stop its core.'
Write-Host 'Your subscriptions and local configuration files have been preserved.'
