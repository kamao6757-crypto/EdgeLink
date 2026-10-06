$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageName = 'EdgeLink-v0.1.3-win-x64'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $projectRoot "output\packages\$packageName-$stamp\$packageName"
$dist = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $stage,$dist -Force | Out-Null
foreach ($folder in @('extension','scripts','tests','third-party')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $folder) -Destination (Join-Path $stage $folder) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $stage 'native\bin') -Force | Out-Null
foreach ($file in @('Host.cs','Installer.cs','EdgeLink.Host.exe','extension-id.txt','CORE-SOURCE.json','GEODATA-SOURCE.json')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "native\$file") -Destination (Join-Path $stage "native\$file")
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\bin\mihomo.exe') -Destination (Join-Path $stage 'native\bin\mihomo.exe')
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\geodata') -Destination (Join-Path $stage 'native\geodata') -Recurse
foreach ($file in @('README.md','VERIFICATION.md','LICENSE','PRODUCT.md','DESIGN.md','package.json','package-lock.json','安装本机助手.cmd','卸载本机助手.cmd')) {
    $source = Join-Path $projectRoot $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file) }
}
$preview = Join-Path $projectRoot 'output\playwright\02-home-configured.png'
if (Test-Path -LiteralPath $preview) { Copy-Item -LiteralPath $preview -Destination (Join-Path $stage '界面预览.png') }
$regionPreview = Join-Path $projectRoot 'output\playwright\0.1.3-exit-region.png'
if (Test-Path -LiteralPath $regionPreview) { Copy-Item -LiteralPath $regionPreview -Destination (Join-Path $stage '出口地区实测.png') }
foreach ($report in @('geo-refresh-report.json','geo-refresh-old-reproduction.json','subscription-activation-report.json','native-geodata-report.json')) {
    $source = Join-Path $projectRoot "output\diagnostics\$report"
    if (Test-Path -LiteralPath $source) {
        $evidenceDirectory = Join-Path $stage 'output\diagnostics'
        New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $evidenceDirectory $report)
    }
}
foreach ($image in @('0.1.3-exit-region.png','0.1.3-geo-refresh-local-fixture.png')) {
    $source = Join-Path $projectRoot "output\playwright\$image"
    if (Test-Path -LiteralPath $source) {
        $evidenceDirectory = Join-Path $stage 'output\playwright'
        New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $evidenceDirectory $image)
    }
}
$destination = Join-Path $dist "$packageName.zip"
Compress-Archive -LiteralPath $stage -DestinationPath $destination -CompressionLevel Optimal -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($destination)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
    foreach ($required in @('extension/manifest.json','extension/background.js','extension/vendor/js-yaml.mjs','native/Installer.cs','native/EdgeLink.Host.exe','native/bin/mihomo.exe','native/geodata/Country.mmdb','native/geodata/GeoIP.dat','native/geodata/GeoSite.dat','native/GEODATA-SOURCE.json','scripts/install.ps1','scripts/build-installer.ps1','scripts/test-installer.mjs','README.md')) {
        if (-not ($names | Where-Object { $_.EndsWith('/' + $required) })) { throw "Package missing: $required" }
    }
    if ($names | Where-Object { $_ -match '/native/data/|registration-backup.json|/node_modules/|/com.edgelink.mihomo.json$' }) { throw 'Package includes machine-specific or private runtime files.' }
    Write-Host "Verified $($zip.Entries.Count) ZIP entries."
} finally { $zip.Dispose() }
$hash = Get-FileHash -LiteralPath $destination -Algorithm SHA256
[System.IO.File]::WriteAllText(($destination + '.sha256'), ($hash.Hash.ToLowerInvariant() + '  ' + [System.IO.Path]::GetFileName($destination) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Get-Item -LiteralPath $destination | Select-Object FullName,Length
Write-Host "SHA256: $($hash.Hash.ToLowerInvariant())"
