[CmdletBinding()]
param(
    [string]$Port,
    [int]$PollSeconds = 1,
    [string]$Telem2Url = 'http://localhost:5050',
    [string]$OperatorName = '',
    [switch]$Once,
    [switch]$VerboseLog
)

# Betaflight CLI safety sequence:
#   #       enter CLI over the FC serial port
#   msc     reboot into USB mass-storage mode
# Betaflight then stops normal operation until the FC is power-cycled.

$ErrorActionPreference = 'Stop'
$logPrefix = '[Telem2 Betaflight MSC]'
function Write-Log([string]$Message) { Write-Host "$logPrefix $Message" }

function Report-Status([string]$Status,[string]$TargetPort,[string]$Message,[string]$ConnectionId) { try { Invoke-RestMethod -Uri ($Telem2Url.TrimEnd('/') + '/api/drone-status') -Method Post -ContentType 'application/json' -Body (@{state=$Status;port=$TargetPort;computer=$env:COMPUTERNAME;operator=$OperatorName;connection_id=$ConnectionId;message=$Message}|ConvertTo-Json -Compress) | Out-Null } catch { Write-Warning "$logPrefix Could not report status to ${Telem2Url}: $($_.Exception.Message)" } }
function Get-SerialPorts {
    [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object
}

function Send-MassStorageCommand([string]$TargetPort) {
    $connectionId = [guid]::NewGuid().ToString()
    $beforeVolumes = @(Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | ForEach-Object { [string]$_.DriveLetter })
    Write-Log "Opening $TargetPort at 115200 baud."
    Report-Status 'connecting' $TargetPort 'Checking Betaflight firmware' $connectionId
    $serial = New-Object System.IO.Ports.SerialPort $TargetPort,115200,None,8,one
    $serial.ReadTimeout = 1000
    $serial.WriteTimeout = 1000
    try {
        $serial.Open()
        Start-Sleep -Milliseconds 250
        # Enter CLI, identify the firmware, and only then issue msc. This prevents
        # accidentally sending the command to an unrelated serial device.
        $serial.Write("#`r`n")
        Start-Sleep -Milliseconds 250
        $serial.DiscardInBuffer()
        $serial.Write("version`r`n")
        Start-Sleep -Milliseconds 500
        $response = ''
        try { $response = $serial.ReadExisting() } catch { }
        if ($response -notmatch '(?i)betaflight') {
            throw "The device on $TargetPort did not identify itself as Betaflight; no msc command was sent."
        }
        $serial.Write("msc`r`n")
        Report-Status 'verified' $TargetPort 'Betaflight verified; switching to mass storage' $connectionId
        Write-Log "Verified Betaflight on $TargetPort and sent '#', 'version', then 'msc'."
        Report-Status 'mass_storage' $TargetPort 'Flight controller rebooted into mass-storage mode' $connectionId
        if ($massStorageDevices) { $massStorageBaselines[$TargetPort] = $beforeVolumes; $massStorageDevices[$TargetPort] = @(); $massStorageConnectionIds[$TargetPort] = $connectionId }
        Write-Log 'The FC should now appear as a USB mass-storage drive. Power-cycle it after transfer.'
    }
    finally {
        if ($serial.IsOpen) { $serial.Close() }
        $serial.Dispose()
    }
}

if ($Port) {
    Send-MassStorageCommand $Port
    exit 0
}

$known = @(Get-SerialPorts)
$massStorageDevices = @{}
$massStorageBaselines = @{}
$massStorageConnectionIds = @{}
Write-Log "Reporting drone status to $Telem2Url"
Write-Log "Watching for a newly connected Betaflight USB serial port. Press Ctrl+C to stop."
if ($known.Count) { Write-Log "Currently present: $($known -join ', ')" }

while ($true) {
    Start-Sleep -Seconds ([Math]::Max(1,$PollSeconds))
    $current = @(Get-SerialPorts)
    foreach ($devicePort in @($massStorageDevices.Keys)) {
        $currentVolumes = @(Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | ForEach-Object { [string]$_.DriveLetter })
        $knownVolumes = @($massStorageDevices[$devicePort])
        if ($knownVolumes.Count -eq 0) {
            $baseline = @($massStorageBaselines[$devicePort])
            $newVolumes = @($currentVolumes | Where-Object { $baseline -notcontains $_ })
            if ($newVolumes.Count -gt 0) {
                $massStorageDevices[$devicePort] = $newVolumes
                Write-Log "Mass-storage drive assigned to ${devicePort}: $($newVolumes -join ', ')"
            }
            continue
        }
        $removedVolumes = @($knownVolumes | Where-Object { $currentVolumes -notcontains $_ })
        if ($removedVolumes.Count -gt 0) {
            Report-Status 'disconnected' $devicePort 'Mass-storage drive disconnected' $massStorageConnectionIds[$devicePort]
            Write-Log "Mass-storage drive disconnected for $devicePort."
            $massStorageDevices.Remove($devicePort)
            $massStorageBaselines.Remove($devicePort)
            $massStorageConnectionIds.Remove($devicePort)
        }
    }
    $newPorts = @($current | Where-Object { $known -notcontains $_ })
    foreach ($newPort in $newPorts) {
        Write-Log "New serial port detected: $newPort"
        try {
            Send-MassStorageCommand $newPort
        }
        catch {
            Write-Warning "$logPrefix Could not send the command to ${newPort}: $($_.Exception.Message)"
        }
        if ($Once) { exit 0 }
    }
    $known = $current
}
