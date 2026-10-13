$command = if ($args.Count -gt 0) { [string]$args[0] } else { 'help' }
$option = if ($args.Count -gt 1) { [string]$args[1] } else { '' }
$options = @($args | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
$container = if ($env:KOKORO_CONTAINER) { $env:KOKORO_CONTAINER } else { 'kokoro' }
$port = if ($env:KOKORO_PORT) { $env:KOKORO_PORT } else { '8880' }
$image = if ($env:KOKORO_IMAGE) { $env:KOKORO_IMAGE } else { 'ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0' }
$waitSeconds = if ($env:KOKORO_WAIT_SECONDS) { $env:KOKORO_WAIT_SECONDS } else { '180' }
$kokoroUrl = "http://localhost:$port"
$scriptCommand = 'powershell -ExecutionPolicy Bypass -File scripts\kokoro.ps1'

function Stop-WithMessage([string]$Message, [int]$ExitCode = 1) {
    Write-Host $Message
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
    if ($port -notmatch '^\d+$') { Stop-WithMessage "KOKORO_PORT must be a number, not `"$port`"." }
    if ($waitSeconds -notmatch '^\d+$') { Stop-WithMessage "KOKORO_WAIT_SECONDS must be a number, not `"$waitSeconds`"." }
}

function Assert-DockerReady {
    if (-not (Test-DockerInstalled)) {
        Stop-WithMessage 'Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Rancher Desktop (https://rancherdesktop.io/), then run this again.'
    }
    if (-not (Test-DockerRunning)) {
        Stop-WithMessage 'Docker is installed but not running. Start Docker Desktop or Rancher Desktop, then run this again.'
    }
}

function New-KokoroContainer {
    $runOptions = @('run', '-d', '--name', $container, '-p', "127.0.0.1:${port}:8880", '--restart', 'unless-stopped')
    if ($image -like '*-gpu*') { $runOptions += @('--gpus', 'all') }
    if (Test-ImageDownloaded) {
        Write-Host "Creating the Kokoro container `"$container`"."
    } else {
        Write-Host 'Setting up Kokoro for the first time. This downloads about 1.5 GB and can take several minutes.'
    }
    docker @runOptions $image | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker could not create the Kokoro container. See the message above.' }
}

function Wait-UntilReady {
    $deadline = (Get-Date).AddSeconds([int]$waitSeconds)
    if (-not (Get-Voices)) {
        Write-Host -NoNewline 'Waiting for Kokoro to answer'
        while (-not (Get-Voices)) {
            if ((Get-ContainerState) -in @('exited', 'dead', 'restarting')) {
                Write-Host ''
                Stop-WithMessage "Kokoro stopped unexpectedly while starting. See what went wrong with: docker logs $container"
            }
            if ((Get-Date) -ge $deadline) {
                Write-Host ''
                Write-Host "Kokoro did not answer at $kokoroUrl within $waitSeconds seconds. Check the setup with: $scriptCommand status"
                Stop-WithMessage "See what Kokoro reports with: docker logs $container"
            }
            Write-Host -NoNewline '.'
            Start-Sleep -Seconds 2
        }
        Write-Host ''
    }
    Write-Host "Kokoro is ready at $kokoroUrl"
}

function Start-Kokoro {
    Assert-DockerReady
    $state = Get-ContainerState
    if (-not $state) {
        New-KokoroContainer
    } elseif ($state -eq 'running') {
        Write-Host 'Kokoro is already running.'
    } else {
        Write-Host 'Starting Kokoro.'
        docker start $container | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker could not start Kokoro. See the message above.' }
    }
    Wait-UntilReady
}

function Stop-Kokoro {
    if (-not (Test-DockerInstalled)) { Write-Host 'Docker is not installed, so Kokoro is not running.'; return }
    if (-not (Test-DockerRunning)) { Write-Host 'Docker is not running, so Kokoro is not running either.'; return }
    $state = Get-ContainerState
    if (-not $state) {
        Write-Host "There is no Kokoro container named `"$container`". Nothing to stop."
    } elseif ($state -in @('running', 'restarting', 'paused')) {
        docker stop $container | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker could not stop Kokoro. See the message above.' }
        Write-Host "Kokoro stopped. It stays stopped until you run: $scriptCommand start"
    } else {
        Write-Host 'Kokoro is already stopped.'
    }
}

function Show-Network {
    $addresses = @(Get-PublishedAddresses)
    if ($addresses.Count -eq 0) {
        Write-Host "Network: Kokoro's port is not published, so the app cannot reach it. Fix it with: $scriptCommand reset"
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
    if ($localOnly) {
        Write-Host 'Network: only this computer can reach Kokoro.'
    } else {
        Write-Host "Network: warning, Kokoro listens on all network interfaces, so other computers on your network can reach it. Limit it to this computer with: $scriptCommand reset"
    }
    if ($publishedPorts -notcontains $port) {
        Write-Host "Port: Kokoro is published on port $($publishedPorts -join ' '), but this script checks port $port. Set KOKORO_PORT or run: $scriptCommand reset"
    }
}

function Show-DockerAndContainer {
    if (-not (Test-DockerInstalled)) {
        Write-Host 'Docker: not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Rancher Desktop (https://rancherdesktop.io/).'
        return
    }
    Write-Host 'Docker: installed.'
    if (-not (Test-DockerRunning)) {
        Write-Host 'Docker: not running. Start Docker Desktop or Rancher Desktop.'
        return
    }
    Write-Host 'Docker: running.'
    $state = Get-ContainerState
    if (-not $state) {
        Write-Host "Container: there is no Kokoro container named `"$container`". Create it with: $scriptCommand start"
        return
    }
    if ($state -eq 'running') {
        Write-Host "Container: `"$container`" exists and is running."
    } else {
        Write-Host "Container: `"$container`" exists but is stopped. Start it with: $scriptCommand start"
    }
    Show-Network
}

function Show-Status {
    Show-DockerAndContainer
    $voices = Get-Voices
    if (-not $voices) { Stop-WithMessage "Kokoro: not answering at $kokoroUrl." }
    Write-Host "Kokoro: answering at $kokoroUrl with $(@($voices.voices).Count) voices."
}

function Confirm-Change {
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { Stop-WithMessage 'Nothing changed.' }
}

function Remove-KokoroContainer {
    if (-not (Get-ContainerState)) { return }
    docker rm -f $container | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker could not remove the Kokoro container. See the message above.' }
    Write-Host "Removed the Kokoro container `"$container`"."
}

function Remove-KokoroImage {
    if (-not (Test-ImageDownloaded)) { return }
    docker image rm $image | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Docker could not remove the image $image. See the message above." }
    Write-Host "Removed the Kokoro image $image."
}

function Reset-Kokoro {
    if ($option -and $option -notin @('--yes', '-yes')) {
        Write-Host "Unknown option: $option"
        Stop-WithMessage "Use: $scriptCommand reset [--yes]" 2
    }
    Assert-DockerReady
    Write-Host "Reset removes the Kokoro container `"$container`" and creates it again, reachable only from this computer on port $port."
    if (Test-ImageDownloaded) {
        Write-Host 'The downloaded Kokoro image is kept, so nothing is downloaded again.'
    } else {
        Write-Host "The image $image is not downloaded yet, so Kokoro downloads it first."
    }
    if (-not $option) { Confirm-Change }
    Remove-KokoroContainer
    Start-Kokoro
}

function Show-Removal([bool]$IncludeImage) {
    if (-not (Get-ContainerState)) {
        Write-Host "There is no Kokoro container named `"$container`"."
    } elseif ($IncludeImage) {
        Write-Host "This removes the Kokoro container `"$container`"."
    } elseif (Test-ImageDownloaded) {
        Write-Host "This removes the Kokoro container `"$container`". The next start creates it again without downloading."
        Write-Host "The downloaded Kokoro image is kept. To remove it too, run: $scriptCommand remove --all"
    } else {
        Write-Host "This removes the Kokoro container `"$container`". The image $image is not downloaded, so the next start downloads it first."
    }
    if (-not $IncludeImage) { return }
    if (Test-ImageDownloaded) {
        Write-Host "This removes the downloaded Kokoro image $image to free about 1.5 GB. The next start downloads it again."
    } else {
        Write-Host "The Kokoro image $image is not downloaded, so there is no image to remove."
    }
}

function Test-SomethingToRemove([bool]$IncludeImage) {
    if (Get-ContainerState) { return $true }
    return $IncludeImage -and (Test-ImageDownloaded)
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
            Write-Host "Unknown option: $removeOption"
            Stop-WithMessage "Use: $scriptCommand remove [--all] [--yes]" 2
        }
    }
    if (-not (Test-DockerInstalled)) { Write-Host 'Docker is not installed, so there is no Kokoro container or image to remove.'; return }
    if (-not (Test-DockerRunning)) { Stop-WithMessage 'Docker is not running, so nothing was removed. Start Docker Desktop or Rancher Desktop, then run this again.' }
    Show-Removal $includeImage
    if (-not (Test-SomethingToRemove $includeImage)) {
        Write-Host 'Nothing to remove.'
        return
    }
    if (-not $confirmed) { Confirm-Change }
    Remove-KokoroContainer
    if ($includeImage) { Remove-KokoroImage }
}

function Show-Help {
    Write-Host @"
$scriptCommand <start|stop|status|reset|remove|help>

Runs Kokoro, the local voice server for AI voiceover, in Docker.
  start                 Create or start Kokoro and wait until it answers
  stop                  Stop Kokoro; it stays installed
  status                Show whether Docker and Kokoro are running
  reset [--yes]         Remove and recreate the Kokoro container; no new download
  remove [--yes]        Remove the Kokoro container; the downloaded image stays
  remove --all [--yes]  Also remove the downloaded image (about 1.5 GB) to uninstall Kokoro
  help                  Show this help

Settings (environment variables):
  KOKORO_CONTAINER     Container name (default kokoro)
  KOKORO_PORT          Port on this computer (default 8880)
  KOKORO_IMAGE         Docker image (default ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0)
                       An image with -gpu in its name also gets --gpus all
  KOKORO_WAIT_SECONDS  How long start waits for Kokoro (default 180)
"@
}

Assert-Settings
switch ($command) {
    'start' { Start-Kokoro }
    'stop' { Stop-Kokoro }
    'status' { Show-Status }
    'reset' { Reset-Kokoro }
    'remove' { Remove-Kokoro }
    'help' { Show-Help }
    default {
        Write-Host "Unknown command: $command"
        Stop-WithMessage "Use: $scriptCommand help" 2
    }
}
exit 0
