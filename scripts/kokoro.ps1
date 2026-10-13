$command = if ($args.Count -gt 0) { [string]$args[0] } else { 'help' }
$option = if ($args.Count -gt 1) { [string]$args[1] } else { '' }
$options = @($args | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
$container = if ($env:KOKORO_CONTAINER) { $env:KOKORO_CONTAINER } else { 'kokoro' }
$port = if ($env:KOKORO_PORT) { $env:KOKORO_PORT } else { '8880' }
$image = if ($env:KOKORO_IMAGE) { $env:KOKORO_IMAGE } else { 'ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0' }
$waitSeconds = if ($env:KOKORO_WAIT_SECONDS) { $env:KOKORO_WAIT_SECONDS } else { '180' }
$kokoroUrl = "http://localhost:$port"
$scriptCommand = 'powershell -ExecutionPolicy Bypass -File scripts\kokoro.ps1'

$interactive = -not [Console]::IsOutputRedirected
$useColor = $interactive -and -not $env:NO_COLOR
$okSymbol = [string][char]0x2713
$failSymbol = [string][char]0x2717
$arrow = [string][char]0x2192
$separator = [string][char]0x00B7
$ellipsis = [string][char]0x2026

function Write-Part([string]$Text, [string]$Color = '') {
    if ($useColor -and $Color) {
        Write-Host -NoNewline $Text -ForegroundColor $Color
    } else {
        Write-Host -NoNewline $Text
    }
}

function Write-Report([string]$Symbol, [string]$Color, [string]$Text, [string]$Detail = '', [string]$Fix = '') {
    Write-Part $Symbol $Color
    Write-Part " $Text"
    if ($Detail) { Write-Part " $separator $Detail" 'DarkGray' }
    if ($Fix) { Write-Part " $arrow $Fix" }
    Write-Host ''
}

function Write-Good([string]$Text, [string]$Detail = '') { Write-Report $okSymbol 'Green' $Text $Detail }
function Write-Caution([string]$Text, [string]$Fix) { Write-Report '!' 'Yellow' $Text '' $Fix }
function Write-Problem([string]$Text, [string]$Fix = '') { Write-Report $failSymbol 'Red' $Text '' $Fix }

function Write-Muted([string]$Text) {
    Write-Part $Text 'DarkGray'
    Write-Host ''
}

function Stop-WithError([string]$Text, [string]$Fix = '', [int]$ExitCode = 1) {
    Write-Problem $Text $Fix
    exit $ExitCode
}

function Test-DockerInstalled { [bool](Get-Command docker -ErrorAction SilentlyContinue) }

function Test-DockerRunning {
    docker info 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}

function Get-ContainerState {
    $state = docker container inspect -f '{{.State.Status}}' $container 2>$null
    if ($LASTEXITCODE -eq 0) { return [string]$state }
    return ''
}

function Test-ImageDownloaded {
    docker image inspect $image 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}

function Get-Voices {
    try { return Invoke-RestMethod -Uri "$kokoroUrl/v1/audio/voices" -TimeoutSec 3 -ErrorAction Stop }
    catch { return $null }
}

function Get-PublishedAddresses {
    $bindingsJson = docker container inspect -f '{{json .HostConfig.PortBindings}}' $container 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $bindingsJson) { return @() }
    $bindings = ($bindingsJson | Out-String | ConvertFrom-Json).'8880/tcp'
    return @($bindings | Where-Object { $_ } | ForEach-Object { "$($_.HostIp):$($_.HostPort)" })
}

function Assert-Settings {
    if ($port -notmatch '^\d+$') { Stop-WithError "KOKORO_PORT must be a number, not `"$port`"" }
    if ($waitSeconds -notmatch '^\d+$') { Stop-WithError "KOKORO_WAIT_SECONDS must be a number, not `"$waitSeconds`"" }
}

function Assert-DockerReady {
    if (-not (Test-DockerInstalled)) { Stop-WithError "Docker isn't installed" 'install Docker Desktop or Rancher Desktop' }
    if (-not (Test-DockerRunning)) { Stop-WithError "Docker isn't running" 'start Docker Desktop or Rancher Desktop' }
}

function New-KokoroContainer {
    $runOptions = @('run', '-d', '--name', $container, '-p', "127.0.0.1:${port}:8880", '--restart', 'unless-stopped')
    if ($image -like '*-gpu*') { $runOptions += @('--gpus', 'all') }
    if (-not (Test-ImageDownloaded)) {
        Write-Part 'Downloading Kokoro '
        Write-Part '(about 1.5 GB, first time only)' 'DarkGray'
        Write-Host $ellipsis
    }
    docker @runOptions $image | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker couldn't create the Kokoro container" "see Docker's message above" }
}

function Show-Waiting([int]$Elapsed) {
    if ($interactive) {
        Write-Part "`r$(' ' * 30)`rStarting Kokoro "
        Write-Part "$separator ${Elapsed}s" 'DarkGray'
    } else {
        Write-Part '.'
    }
}

function Complete-Waiting {
    if ($interactive) { Write-Part "`r$(' ' * 30)`r" } else { Write-Host '' }
}

function Wait-UntilReady {
    $started = Get-Date
    $deadline = $started.AddSeconds([int]$waitSeconds)
    if (-not (Get-Voices)) {
        Write-Part 'Starting Kokoro'
        while (-not (Get-Voices)) {
            if ((Get-ContainerState) -in @('exited', 'dead', 'restarting')) {
                Complete-Waiting
                Stop-WithError 'Kokoro stopped while starting' "docker logs $container"
            }
            if ((Get-Date) -ge $deadline) {
                Complete-Waiting
                Stop-WithError "Kokoro didn't answer at $kokoroUrl within ${waitSeconds}s" "docker logs $container"
            }
            Show-Waiting ([int]((Get-Date) - $started).TotalSeconds)
            Start-Sleep -Seconds 2
        }
        Complete-Waiting
    }
    Write-Good 'Kokoro ready' $kokoroUrl
}

function Start-Kokoro {
    Assert-DockerReady
    $state = Get-ContainerState
    if (-not $state) {
        New-KokoroContainer
    } elseif ($state -ne 'running') {
        docker start $container | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker couldn't start Kokoro" "see Docker's message above" }
    }
    Wait-UntilReady
}

function Stop-Kokoro {
    if (-not (Test-DockerInstalled)) { Write-Muted "Nothing to stop $separator Docker isn't installed"; return }
    if (-not (Test-DockerRunning)) { Write-Muted "Nothing to stop $separator Docker isn't running"; return }
    $state = Get-ContainerState
    if (-not $state) {
        Write-Muted "Nothing to stop $separator no Kokoro container"
    } elseif ($state -in @('running', 'restarting', 'paused')) {
        docker stop $container | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker couldn't stop Kokoro" "see Docker's message above" }
        Write-Good 'Kokoro stopped' "stays off until $scriptCommand start"
    } else {
        Write-Good 'Kokoro already stopped'
    }
}

function Show-Network {
    $addresses = @(Get-PublishedAddresses)
    if ($addresses.Count -eq 0) {
        Write-Caution "Kokoro's port isn't published" "$scriptCommand reset"
        return
    }
    $localOnly = $true
    $publishedPorts = @()
    foreach ($address in $addresses) {
        $publishedPorts += $address.Substring($address.LastIndexOf(':') + 1)
        if (-not ($address.StartsWith('127.0.0.1:') -or $address.StartsWith('::1:') -or $address.StartsWith('localhost:'))) {
            $localOnly = $false
        }
    }
    if (-not $localOnly) {
        Write-Caution 'Reachable from your network' "$scriptCommand reset"
    }
    if ($publishedPorts -notcontains $port) {
        Write-Caution "Kokoro uses port $($publishedPorts -join ' '), not $port" "$scriptCommand reset"
    }
}

function Test-KokoroLayers {
    if (-not (Test-DockerInstalled)) {
        Write-Problem "Docker isn't installed" 'install Docker Desktop or Rancher Desktop'
        return $false
    }
    if (-not (Test-DockerRunning)) {
        Write-Problem "Docker isn't running" 'start Docker Desktop or Rancher Desktop'
        return $false
    }
    Write-Good 'Docker running'
    $state = Get-ContainerState
    if (-not $state) {
        Write-Problem 'No Kokoro container' "$scriptCommand start"
        return $false
    }
    if ($state -ne 'running') {
        Write-Problem 'Kokoro stopped' "$scriptCommand start"
        return $false
    }
    return $true
}

function Show-Status {
    $voices = Get-Voices
    $layersReady = Test-KokoroLayers
    if ($voices) {
        Write-Good 'Kokoro running' "$(@($voices.voices).Count) voices $separator $kokoroUrl"
    } elseif ($layersReady) {
        Write-Problem "Kokoro isn't answering at $kokoroUrl" "$scriptCommand start"
    }
    if ($layersReady) { Show-Network }
    if (-not $voices) { exit 1 }
}

function Confirm-Change([string]$Question) {
    $answer = Read-Host "$Question [y/N]"
    if ($answer -notmatch '^(y|yes)$') {
        Write-Muted 'Nothing changed'
        exit 1
    }
}

function Remove-KokoroContainer {
    if (-not (Get-ContainerState)) { return }
    docker rm -f $container | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker couldn't remove the Kokoro container" "see Docker's message above" }
}

function Remove-KokoroImage {
    if (-not (Test-ImageDownloaded)) { return }
    docker image rm $image | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Docker couldn't remove $image" "see Docker's message above" }
}

function Reset-Kokoro {
    if ($option -and $option -notin @('--yes', '-yes')) {
        Stop-WithError "Unknown option $option" "$scriptCommand reset [--yes]" 2
    }
    Assert-DockerReady
    if (-not $option) {
        if (Test-ImageDownloaded) {
            Confirm-Change 'Recreate the Kokoro container? The download is kept.'
        } else {
            Confirm-Change 'Recreate the Kokoro container? It downloads about 1.5 GB first.'
        }
    }
    Remove-KokoroContainer
    Start-Kokoro
}

function Get-RemovalQuestion([bool]$HasContainer, [bool]$HasImage, [bool]$IncludeImage) {
    if ($HasContainer -and $HasImage -and $IncludeImage) { return 'Remove the Kokoro container and the download (about 1.5 GB)?' }
    if ($HasContainer -and $HasImage) { return 'Remove the Kokoro container? The download is kept.' }
    if ($HasContainer) { return 'Remove the Kokoro container?' }
    return 'Remove the Kokoro download (about 1.5 GB)?'
}

function Remove-Kokoro {
    $includeImage = $false
    $confirmed = $false
    foreach ($removeOption in $options) {
        if ($removeOption -in @('--all', '-all')) {
            $includeImage = $true
        } elseif ($removeOption -in @('--yes', '-yes')) {
            $confirmed = $true
        } else {
            Stop-WithError "Unknown option $removeOption" "$scriptCommand remove [--all] [--yes]" 2
        }
    }
    if (-not (Test-DockerInstalled)) { Write-Muted "Nothing to remove $separator Docker isn't installed"; return }
    if (-not (Test-DockerRunning)) { Stop-WithError "Docker isn't running" 'start Docker Desktop or Rancher Desktop' }
    $hasContainer = [bool](Get-ContainerState)
    $hasImage = [bool](Test-ImageDownloaded)
    if (-not $hasContainer -and -not $includeImage) {
        Write-Muted "Nothing to remove $separator no Kokoro container"
        return
    }
    if (-not $hasContainer -and -not $hasImage) {
        Write-Muted "Nothing to remove $separator no Kokoro container or download"
        return
    }
    if (-not $confirmed) { Confirm-Change (Get-RemovalQuestion $hasContainer $hasImage $includeImage) }
    Remove-KokoroContainer
    if ($includeImage) { Remove-KokoroImage }
    Write-Good 'Removed'
}

function Show-Setting([string]$Name, [string]$Description, [string]$Default) {
    Write-Part ('  {0,-21} {1} ' -f $Name, $Description)
    Write-Part "($Default)" 'DarkGray'
    Write-Host ''
}

function Show-Help {
    Write-Host @"
Runs Kokoro, the local voice server for AI voiceover, in Docker.
Usage: $scriptCommand <command>
  start                 Start Kokoro and wait until it answers
  stop                  Stop Kokoro; it stays installed
  status                Check Docker and Kokoro
  reset [--yes]         Recreate the container; the download is kept
  remove [--yes]        Remove the container; the download is kept
  remove --all [--yes]  Also remove the download (about 1.5 GB)
  help                  Show this help
Environment:
"@
    Show-Setting 'KOKORO_CONTAINER' 'Container name' 'kokoro'
    Show-Setting 'KOKORO_PORT' 'Port on this computer' '8880'
    Show-Setting 'KOKORO_IMAGE' 'Docker image; -gpu in the name adds --gpus all' 'ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0'
    Show-Setting 'KOKORO_WAIT_SECONDS' 'Seconds start waits for Kokoro' '180'
}

Assert-Settings
switch ($command) {
    'start' { Start-Kokoro }
    'stop' { Stop-Kokoro }
    'status' { Show-Status }
    'reset' { Reset-Kokoro }
    'remove' { Remove-Kokoro }
    'help' { Show-Help }
    default { Stop-WithError "Unknown command $command" "$scriptCommand help" 2 }
}
exit 0
