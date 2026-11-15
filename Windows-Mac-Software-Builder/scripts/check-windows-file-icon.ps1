$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:WSMB_QA_EXE)
if ($info.ProductName -cne $env:WSMB_QA_TITLE) { throw 'The exported EXE product name does not match the project.' }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:WSMB_QA_EXE)
if (-not $icon) { throw 'The exported EXE has no shell icon.' }
$bitmap = $icon.ToBitmap()
try {
    $color = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 2)).ToArgb().ToString('X8')
    if ($color -ne $env:WSMB_QA_ICON_COLOR) { throw "Unexpected EXE shell icon color: $color" }
    'EXE_FILE_ICON_READY'
} finally { $bitmap.Dispose(); $icon.Dispose() }
