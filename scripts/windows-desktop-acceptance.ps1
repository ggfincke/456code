# scripts/windows-desktop-acceptance.ps1
# exercise installed Windows backend, native payload, updater paths, and cleanup

param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactsRoot,
  [string]$VersionN = "0.0.17-nightly.20990101.1",
  [string]$VersionN1 = "0.0.17-nightly.20990101.2",
  [int]$UpdatePort = 41230
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw $Message
  }
}

function Wait-Until {
  param(
    [scriptblock]$Probe,
    [string]$Description,
    [int]$TimeoutSeconds = 120,
    [int]$IntervalMilliseconds = 500
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      if (& $Probe) {
        return
      }
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw
      }
    }
    Start-Sleep -Milliseconds $IntervalMilliseconds
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Description."
}

function Stop-InstalledAppProcesses {
  param([string]$InstallDirectory)
  $prefix = $InstallDirectory.TrimEnd("\") + "\"
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Seconds 2
}

function Get-InstalledExecutableProcessIds {
  param([string]$ExecutablePath)
  return @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.Equals($ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { [int]$_.ProcessId }
  )
}

$script:CdpMessageId = 0

function Invoke-CdpExpression {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Expression,
    [bool]$AwaitPromise = $true
  )
  $script:CdpMessageId += 1
  $messageId = $script:CdpMessageId
  $payload = @{
    id = $messageId
    method = "Runtime.evaluate"
    params = @{
      expression = $Expression
      awaitPromise = $AwaitPromise
      returnByValue = $true
    }
  } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $Socket.SendAsync(
    $segment,
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()

  while ($true) {
    $stream = [IO.MemoryStream]::new()
    try {
      do {
        $buffer = [byte[]]::new(65536)
        $receiveSegment = [ArraySegment[byte]]::new($buffer)
        $received = $Socket.ReceiveAsync(
          $receiveSegment,
          [Threading.CancellationToken]::None
        ).GetAwaiter().GetResult()
        if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          throw "The Electron CDP socket closed while evaluating an expression."
        }
        $stream.Write($buffer, 0, $received.Count)
      } while (-not $received.EndOfMessage)
      $responseText = [Text.Encoding]::UTF8.GetString($stream.ToArray())
    } finally {
      $stream.Dispose()
    }
    $response = $responseText | ConvertFrom-Json -Depth 20
    $idProperty = $response.PSObject.Properties["id"]
    if ($null -eq $idProperty -or $idProperty.Value -ne $messageId) {
      continue
    }
    $errorProperty = $response.PSObject.Properties["error"]
    if ($null -ne $errorProperty) {
      throw "CDP error: $($errorProperty.Value | ConvertTo-Json -Compress)"
    }
    $result = $response.result
    $exceptionProperty = $result.PSObject.Properties["exceptionDetails"]
    if ($null -ne $exceptionProperty) {
      throw "Renderer exception: $($exceptionProperty.Value | ConvertTo-Json -Depth 10 -Compress)"
    }
    return $result.result.value
  }
}

function Connect-DesktopBridge {
  param([int]$Port, [int]$TimeoutSeconds = 180)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $targets = @(Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 3)
      foreach ($target in $targets) {
        $debuggerUrlProperty = $target.PSObject.Properties["webSocketDebuggerUrl"]
        if ($null -eq $debuggerUrlProperty -or -not $debuggerUrlProperty.Value) {
          continue
        }
        $socket = [System.Net.WebSockets.ClientWebSocket]::new()
        try {
          $socket.ConnectAsync(
            [Uri]$debuggerUrlProperty.Value,
            [Threading.CancellationToken]::None
          ).GetAwaiter().GetResult()
          $bridgeType = Invoke-CdpExpression $socket "typeof window.desktopBridge" $false
          if ($bridgeType -eq "object") {
            return $socket
          }
        } catch {
          $socket.Dispose()
          continue
        }
        $socket.Dispose()
      }
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for the packaged desktop bridge on CDP port $Port."
}

function Invoke-BridgeJson {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Expression
  )
  $json = Invoke-CdpExpression $Socket "(async () => JSON.stringify($Expression))()" $true
  return $json | ConvertFrom-Json -Depth 30
}

function Start-AcceptanceApp {
  param([string]$ExecutablePath, [int]$DebugPort, [string]$UserDataDirectory)
  $process = Start-Process -FilePath $ExecutablePath -ArgumentList @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$UserDataDirectory",
    "--disable-gpu"
  ) -PassThru
  $socket = Connect-DesktopBridge $DebugPort
  return @{ Process = $process; Socket = $socket }
}

function Wait-ForUpdateStatus {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Status,
    [int]$TimeoutSeconds = 180
  )
  $state = $null
  Wait-Until -Description "desktop update status '$Status'" -TimeoutSeconds $TimeoutSeconds -Probe {
    $script:CurrentUpdateState = Invoke-BridgeJson $Socket "await window.desktopBridge.getUpdateState()"
    return $script:CurrentUpdateState.status -eq $Status
  }
  $state = $script:CurrentUpdateState
  return $state
}

function Read-FeedLog {
  param([string]$LogPath)
  if (-not (Test-Path $LogPath)) {
    return @()
  }
  return @(
    Get-Content $LogPath |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      ForEach-Object { $_ | ConvertFrom-Json }
  )
}

function Seed-CurrentInstallerCache {
  param([string]$CacheDirectory, [string]$InstallerPath)
  New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
  Copy-Item $InstallerPath (Join-Path $CacheDirectory "installer.exe") -Force
}

$acceptanceRoot = Join-Path $env:RUNNER_TEMP "456code-windows-acceptance"
$installDir = Join-Path $acceptanceRoot "installed"
$feedRoot = Join-Path $acceptanceRoot "feed"
$feedLog = Join-Path $acceptanceRoot "feed-requests.jsonl"
$feedStdout = Join-Path $acceptanceRoot "feed.stdout.log"
$feedStderr = Join-Path $acceptanceRoot "feed.stderr.log"
$stateDir = Join-Path $acceptanceRoot "state"
$userDataDir = Join-Path $acceptanceRoot "electron-user-data"
$appDataDir = Join-Path $acceptanceRoot "appdata"
$localAppDataDir = Join-Path $acceptanceRoot "localappdata"

if (Test-Path $acceptanceRoot) {
  Remove-Item $acceptanceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $feedRoot, $stateDir, $userDataDir, $appDataDir, $localAppDataDir | Out-Null

$versionNDir = Join-Path $ArtifactsRoot "n"
$versionN1Dir = Join-Path $ArtifactsRoot "n1"
$installerN = Get-ChildItem $versionNDir -Filter "*.exe" -File | Select-Object -First 1
$installerN1 = Get-ChildItem $versionN1Dir -Filter "*.exe" -File | Select-Object -First 1
$blockmapN = Get-ChildItem $versionNDir -Filter "*.exe.blockmap" -File | Select-Object -First 1
$blockmapN1 = Get-ChildItem $versionN1Dir -Filter "*.exe.blockmap" -File | Select-Object -First 1
$manifestN1 = Get-ChildItem $versionN1Dir -Filter "*.yml" -File |
  Where-Object { $_.Name -notlike "builder-*" } |
  Select-Object -First 1
Assert-Condition ($null -ne $installerN) "Version N installer is missing."
Assert-Condition ($null -ne $installerN1) "Version N+1 installer is missing."
Assert-Condition ($null -ne $blockmapN) "Version N blockmap is missing."
Assert-Condition ($null -ne $blockmapN1) "Version N+1 blockmap is missing."
Assert-Condition ($null -ne $manifestN1) "Version N+1 update manifest is missing."
Assert-Condition ($installerN.Name.Contains($VersionN)) "Version N installer name does not contain $VersionN."
Assert-Condition ($installerN1.Name.Contains($VersionN1)) "Version N+1 installer name does not contain $VersionN1."

Copy-Item $installerN1.FullName (Join-Path $feedRoot $installerN1.Name)
Copy-Item $blockmapN.FullName (Join-Path $feedRoot $blockmapN.Name)
Copy-Item $blockmapN1.FullName (Join-Path $feedRoot $blockmapN1.Name)
Copy-Item $manifestN1.FullName (Join-Path $feedRoot "latest.yml")
Copy-Item $manifestN1.FullName (Join-Path $feedRoot "nightly.yml")

$env:APPDATA = $appDataDir
$env:LOCALAPPDATA = $localAppDataDir
$env:T3CODE_HOME = $stateDir
$env:T3CODE_DESKTOP_MOCK_UPDATES = "true"
$env:T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT = [string]$UpdatePort
$env:ELECTRON_ENABLE_LOGGING = "1"

$feedProcess = Start-Process -FilePath "node" -ArgumentList @(
  (Join-Path $PSScriptRoot "windows-desktop-update-feed.mjs"),
  "--root", $feedRoot,
  "--port", [string]$UpdatePort,
  "--log", $feedLog
) -RedirectStandardOutput $feedStdout -RedirectStandardError $feedStderr -PassThru

try {
  Wait-Until -Description "local update feed" -TimeoutSeconds 30 -Probe {
    $response = Invoke-WebRequest "http://localhost:$UpdatePort/nightly.yml" -TimeoutSec 2
    return $response.StatusCode -eq 200
  }

  $install = Start-Process -FilePath $installerN.FullName -ArgumentList @(
    "/S",
    "/D=$installDir"
  ) -Wait -PassThru
  Assert-Condition ($install.ExitCode -eq 0) "Silent N install exited $($install.ExitCode)."
  $appExe = Get-ChildItem $installDir -Filter "456code*.exe" -File -Recurse |
    Where-Object { $_.Name -notlike "*Uninstall*" } |
    Select-Object -First 1
  Assert-Condition ($null -ne $appExe) "Installed 456code executable is missing."
  $resourcesDir = Join-Path $installDir "resources"
  Assert-Condition (Test-Path (Join-Path $resourcesDir "server.asar")) "Installed server.asar is missing."
  Assert-Condition (Test-Path (Join-Path $resourcesDir "server.asar.sha256")) "Installed server.asar digest is missing."

  $smoke = Start-Process -FilePath $appExe.FullName -ArgumentList @(
    "--no-global-search-paths",
    (Join-Path $PSScriptRoot "windows-desktop-packaged-smoke.mjs"),
    $installDir
  ) -Wait -PassThru -NoNewWindow -Environment @{ ELECTRON_RUN_AS_NODE = "1" }
  Assert-Condition ($smoke.ExitCode -eq 0) "Packaged native/Cartographer smoke exited $($smoke.ExitCode)."

  $appUpdateYml = Get-Content (Join-Path $resourcesDir "app-update.yml") -Raw
  $cacheMatch = [regex]::Match($appUpdateYml, "(?m)^updaterCacheDirName:\s*(.+?)\s*$")
  Assert-Condition $cacheMatch.Success "app-update.yml does not declare updaterCacheDirName."
  $cacheDir = Join-Path $localAppDataDir $cacheMatch.Groups[1].Value.Trim()
  Seed-CurrentInstallerCache $cacheDir $installerN.FullName

  Set-Content $feedLog ""
  $firstRun = Start-AcceptanceApp $appExe.FullName 9331 $userDataDir
  try {
    $bootstraps = Invoke-BridgeJson $firstRun.Socket "window.desktopBridge.getLocalEnvironmentBootstraps()"
    $primary = @($bootstraps | Where-Object { $_.id -eq "local" -or $_.httpBaseUrl }) | Select-Object -First 1
    Assert-Condition ($null -ne $primary) "The packaged primary backend did not publish a bootstrap."
    $readyUrl = ([Uri]$primary.httpBaseUrl).AbsoluteUri.TrimEnd("/") + "/.well-known/t3/environment"
    $readyResponse = Invoke-WebRequest $readyUrl -TimeoutSec 10
    Assert-Condition ($readyResponse.StatusCode -eq 200) "Packaged backend readiness returned $($readyResponse.StatusCode)."

    $check = Invoke-BridgeJson $firstRun.Socket "await window.desktopBridge.checkForUpdate()"
    Assert-Condition $check.checked "The differential update check was not executed."
    $available = Wait-ForUpdateStatus $firstRun.Socket "available"
    Assert-Condition ($available.availableVersion -eq $VersionN1) "Expected update $VersionN1, received $($available.availableVersion)."
    $download = Invoke-BridgeJson $firstRun.Socket "await window.desktopBridge.downloadUpdate()"
    Assert-Condition ($download.accepted -and $download.completed) "Differential update download did not complete."
    Wait-ForUpdateStatus $firstRun.Socket "downloaded" | Out-Null
  } finally {
    $firstRun.Socket.Dispose()
    Stop-InstalledAppProcesses $installDir
  }

  $differentialLog = Read-FeedLog $feedLog
  Assert-Condition (@($differentialLog | Where-Object { $_.path -eq "/$($blockmapN.Name)" -and $_.status -eq 200 }).Count -gt 0) "Differential path did not request the N blockmap."
  Assert-Condition (@($differentialLog | Where-Object { $_.path -eq "/$($blockmapN1.Name)" -and $_.status -eq 200 }).Count -gt 0) "Differential path did not request the N+1 blockmap."
  Assert-Condition (@($differentialLog | Where-Object { $_.path -eq "/$($installerN1.Name)" -and $_.status -eq 206 -and $_.range }).Count -gt 0) "Differential path did not issue an installer range request."

  $pendingDir = Join-Path $cacheDir "pending"
  Remove-Item $pendingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $cacheDir "current.blockmap") -Force -ErrorAction SilentlyContinue
  Seed-CurrentInstallerCache $cacheDir $installerN.FullName
  New-Item -ItemType Directory -Force -Path $pendingDir | Out-Null
  Set-Content (Join-Path $pendingDir "stale-payload.tmp") "stale"
  Set-Content (Join-Path $pendingDir "update-info.json") '{"corrupt":true}'
  Move-Item (Join-Path $feedRoot $blockmapN.Name) (Join-Path $feedRoot "$($blockmapN.Name).disabled")
  Set-Content $feedLog ""

  $fallbackRun = Start-AcceptanceApp $appExe.FullName 9332 $userDataDir
  try {
    $check = Invoke-BridgeJson $fallbackRun.Socket "await window.desktopBridge.checkForUpdate()"
    Assert-Condition $check.checked "The fallback update check was not executed."
    Wait-ForUpdateStatus $fallbackRun.Socket "available" | Out-Null
    $download = Invoke-BridgeJson $fallbackRun.Socket "await window.desktopBridge.downloadUpdate()"
    Assert-Condition ($download.accepted -and $download.completed) "Fallback update download did not complete."
    Wait-ForUpdateStatus $fallbackRun.Socket "downloaded" | Out-Null
    Assert-Condition (-not (Test-Path (Join-Path $pendingDir "stale-payload.tmp"))) "Updater did not clean the stale pending payload."
    $preInstallProcessIds = @(Get-InstalledExecutableProcessIds $appExe.FullName)
    Assert-Condition ($preInstallProcessIds.Count -gt 0) "No installed app process was present before updater installation."
    try {
      Invoke-CdpExpression $fallbackRun.Socket "void window.desktopBridge.installUpdate(); 'started'" $false | Out-Null
    } catch {
      if (-not $fallbackRun.Process.HasExited) {
        throw
      }
    }
  } finally {
    $fallbackRun.Socket.Dispose()
  }

  $fallbackLog = Read-FeedLog $feedLog
  Assert-Condition (@($fallbackLog | Where-Object { $_.path -eq "/$($blockmapN.Name)" -and $_.status -eq 404 }).Count -gt 0) "Fallback path did not observe the missing N blockmap."
  Assert-Condition (@($fallbackLog | Where-Object {
    $rangeProperty = $_.PSObject.Properties["range"]
    $_.path -eq "/$($installerN1.Name)" -and
      $_.status -eq 200 -and
      ($null -eq $rangeProperty -or -not $rangeProperty.Value)
  }).Count -gt 0) "Fallback path did not download the complete installer."

  Wait-Until -Description "updater-triggered N+1 relaunch" -TimeoutSeconds 180 -Probe {
    $currentProcessIds = @(Get-InstalledExecutableProcessIds $appExe.FullName)
    $oldProcessIds = @($currentProcessIds | Where-Object { $preInstallProcessIds -contains $_ })
    $newProcessIds = @($currentProcessIds | Where-Object { $preInstallProcessIds -notcontains $_ })
    return $oldProcessIds.Count -eq 0 -and $newProcessIds.Count -gt 0
  }
  Stop-InstalledAppProcesses $installDir

  $updatedRun = Start-AcceptanceApp $appExe.FullName 9333 $userDataDir
  try {
    $state = Invoke-BridgeJson $updatedRun.Socket "await window.desktopBridge.getUpdateState()"
    Assert-Condition ($state.currentVersion -eq $VersionN1) "Relaunched app reports $($state.currentVersion), expected $VersionN1."
    $bootstraps = Invoke-BridgeJson $updatedRun.Socket "window.desktopBridge.getLocalEnvironmentBootstraps()"
    Assert-Condition (@($bootstraps).Count -gt 0) "Updated app did not start its packaged backend."
  } finally {
    $updatedRun.Socket.Dispose()
    Stop-InstalledAppProcesses $installDir
  }

  $uninstaller = Get-ChildItem $installDir -Filter "Uninstall*.exe" -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $uninstaller) "Installed uninstaller is missing."
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
  Assert-Condition ($uninstall.ExitCode -eq 0) "Silent uninstall exited $($uninstall.ExitCode)."
  Wait-Until -Description "installed directory cleanup" -TimeoutSeconds 60 -Probe {
    return -not (Test-Path $installDir)
  }
  Remove-Item $stateDir, $userDataDir, $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
  Assert-Condition (-not (Test-Path $stateDir)) "Acceptance state directory was not cleaned."

  Write-Host "Windows desktop acceptance passed: install, packaged backend, PTY/fff/Cartographer, differential range update, full fallback, stale cleanup, N+1 relaunch, uninstall."
} finally {
  Stop-InstalledAppProcesses $installDir
  if ($feedProcess -and -not $feedProcess.HasExited) {
    Stop-Process -Id $feedProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $feedStderr) {
    Get-Content $feedStderr | ForEach-Object { Write-Host $_ }
  }
}
