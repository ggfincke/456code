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
$script:AcceptanceStartedAt = [DateTime]::UtcNow
$script:AcceptanceTimeoutSeconds = 1500
$script:AcceptanceDeadline = $script:AcceptanceStartedAt.AddSeconds($script:AcceptanceTimeoutSeconds)
$script:CdpOperationTimeoutSeconds = 60
$script:CimOperationTimeoutSeconds = 5

function Get-BoundedTimeoutMilliseconds {
  param([int]$TimeoutSeconds)
  $remainingMilliseconds = [Math]::Floor(
    ($script:AcceptanceDeadline - [DateTime]::UtcNow).TotalMilliseconds
  )
  if ($remainingMilliseconds -le 0) {
    throw "Windows acceptance exceeded its $($script:AcceptanceTimeoutSeconds)-second total budget."
  }
  $requestedMilliseconds = [double]$TimeoutSeconds * 1000
  return [int]([Math]::Max(1, [Math]::Min($requestedMilliseconds, $remainingMilliseconds)))
}

function Write-AcceptancePhase {
  param([string]$Name)
  $elapsedSeconds = [Math]::Floor(
    ([DateTime]::UtcNow - $script:AcceptanceStartedAt).TotalSeconds
  )
  $remainingSeconds = [Math]::Max(
    0,
    [Math]::Ceiling(($script:AcceptanceDeadline - [DateTime]::UtcNow).TotalSeconds)
  )
  Write-Host "[windows-acceptance] phase=$Name elapsed=${elapsedSeconds}s remaining=${remainingSeconds}s"
}

function New-BoundedCancellationSource {
  param([int]$TimeoutSeconds)
  $source = [Threading.CancellationTokenSource]::new()
  $source.CancelAfter((Get-BoundedTimeoutMilliseconds $TimeoutSeconds))
  return $source
}

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
  if ($deadline -gt $script:AcceptanceDeadline) {
    $deadline = $script:AcceptanceDeadline
  }
  do {
    Get-BoundedTimeoutMilliseconds 1 | Out-Null
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

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)
  try {
    if (-not $Process.HasExited) {
      $Process.Kill($true)
      if (-not $Process.WaitForExit(10000)) {
        Write-Warning "Process tree for PID $($Process.Id) did not exit within 10 seconds."
      }
    }
  } catch [System.InvalidOperationException] {
    # process exited between the status check and tree kill
  } catch {
    Write-Warning "Process-tree cleanup for PID $($Process.Id) failed: $($_.Exception.Message)"
  }
}

function Stop-InstalledAppProcesses {
  param([string]$InstallDirectory)
  $prefix = $InstallDirectory.TrimEnd("\") + "\"
  Get-CimInstance Win32_Process -OperationTimeoutSec $script:CimOperationTimeoutSeconds |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object {
      $processId = [int]$_.ProcessId
      $process = $null
      try {
        $process = [System.Diagnostics.Process]::GetProcessById($processId)
        if (-not $process.HasExited) {
          $process.Kill($true)
        }
      } catch [System.InvalidOperationException], [System.ArgumentException] {
        # process exited after the CIM snapshot
      } catch {
        Write-Warning "Installed process-tree cleanup for PID $processId failed: $($_.Exception.Message)"
      } finally {
        if ($process) {
          $process.Dispose()
        }
      }
    }
  Start-Sleep -Seconds 2
}

function Get-InstalledExecutableProcessIds {
  param([string]$ExecutablePath)
  return @(
    Get-CimInstance Win32_Process -OperationTimeoutSec $script:CimOperationTimeoutSeconds |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.Equals($ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { [int]$_.ProcessId }
  )
}

function Invoke-BoundedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$Description,
    [int]$TimeoutSeconds,
    [hashtable]$Environment,
    [switch]$NoNewWindow
  )
  $startParameters = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    PassThru = $true
  }
  if ($null -ne $Environment) {
    $startParameters.Environment = $Environment
  }
  if ($NoNewWindow) {
    $startParameters.NoNewWindow = $true
  }

  $process = Start-Process @startParameters
  $timeoutSource = New-BoundedCancellationSource $TimeoutSeconds
  try {
    $process.WaitForExitAsync($timeoutSource.Token).GetAwaiter().GetResult() | Out-Null
    return [int]$process.ExitCode
  } catch [System.OperationCanceledException] {
    Stop-ProcessTree $process
    throw "$Description exceeded its $TimeoutSeconds-second process deadline."
  } catch {
    Stop-ProcessTree $process
    throw
  } finally {
    $timeoutSource.Dispose()
    $process.Dispose()
  }
}

$script:CdpMessageId = 0

function Invoke-CdpExpression {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Expression,
    [bool]$AwaitPromise = $true,
    [int]$TimeoutSeconds = $script:CdpOperationTimeoutSeconds
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
  $timeoutSource = New-BoundedCancellationSource $TimeoutSeconds
  try {
    $Socket.SendAsync(
      $segment,
      [System.Net.WebSockets.WebSocketMessageType]::Text,
      $true,
      $timeoutSource.Token
    ).GetAwaiter().GetResult() | Out-Null

    while ($true) {
      $stream = [IO.MemoryStream]::new()
      try {
        do {
          $buffer = [byte[]]::new(65536)
          $receiveSegment = [ArraySegment[byte]]::new($buffer)
          $received = $Socket.ReceiveAsync(
            $receiveSegment,
            $timeoutSource.Token
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
  } catch [System.OperationCanceledException] {
    throw "CDP evaluation exceeded its $TimeoutSeconds-second deadline."
  } finally {
    $timeoutSource.Dispose()
  }
}

function Connect-DesktopBridge {
  param([int]$Port, [int]$TimeoutSeconds = 180)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  if ($deadline -gt $script:AcceptanceDeadline) {
    $deadline = $script:AcceptanceDeadline
  }
  do {
    Get-BoundedTimeoutMilliseconds 1 | Out-Null
    try {
      $targets = @(Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 3)
      foreach ($target in $targets) {
        $debuggerUrlProperty = $target.PSObject.Properties["webSocketDebuggerUrl"]
        if ($null -eq $debuggerUrlProperty -or -not $debuggerUrlProperty.Value) {
          continue
        }
        $socket = [System.Net.WebSockets.ClientWebSocket]::new()
        $connectTimeoutSource = New-BoundedCancellationSource 10
        try {
          $socket.ConnectAsync(
            [Uri]$debuggerUrlProperty.Value,
            $connectTimeoutSource.Token
          ).GetAwaiter().GetResult() | Out-Null
          $bridgeType = Invoke-CdpExpression $socket "typeof window.desktopBridge" $false 15
          if ($bridgeType -eq "object") {
            return $socket
          }
        } catch {
          $socket.Dispose()
          continue
        } finally {
          $connectTimeoutSource.Dispose()
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
    [string]$Expression,
    [int]$TimeoutSeconds = $script:CdpOperationTimeoutSeconds
  )
  $timeoutMilliseconds = Get-BoundedTimeoutMilliseconds $TimeoutSeconds
  $wrappedExpression = @"
(async () => {
  let timeoutId;
  try {
    const operation = (async () => ($Expression))();
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("bridge operation exceeded $timeoutMilliseconds ms")),
        $timeoutMilliseconds,
      );
    });
    return JSON.stringify(await Promise.race([operation, timeout]));
  } finally {
    clearTimeout(timeoutId);
  }
})()
"@
  $json = Invoke-CdpExpression $Socket $wrappedExpression $true ($TimeoutSeconds + 5)
  return $json | ConvertFrom-Json -Depth 30
}

function Start-AcceptanceApp {
  param([string]$ExecutablePath, [int]$DebugPort, [string]$UserDataDirectory)
  $process = Start-Process -FilePath $ExecutablePath -ArgumentList @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$UserDataDirectory",
    "--disable-gpu"
  ) -PassThru
  try {
    $socket = Connect-DesktopBridge $DebugPort
    return @{ Process = $process; Socket = $socket }
  } catch {
    Stop-ProcessTree $process
    $process.Dispose()
    throw
  }
}

function Wait-ForUpdateStatus {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Status,
    [int]$TimeoutSeconds = 180
  )
  $state = $null
  Wait-Until -Description "desktop update status '$Status'" -TimeoutSeconds $TimeoutSeconds -Probe {
    $script:CurrentUpdateState = Invoke-BridgeJson $Socket "await window.desktopBridge.getUpdateState()" 30
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

Write-AcceptancePhase "start-feed"
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

  Write-AcceptancePhase "install-n"
  $installExitCode = Invoke-BoundedProcess `
    -FilePath $installerN.FullName `
    -ArgumentList @("/S", "/D=$installDir") `
    -Description "Silent N install" `
    -TimeoutSeconds 300
  Assert-Condition ($installExitCode -eq 0) "Silent N install exited $installExitCode."
  $appExe = Get-ChildItem $installDir -Filter "456code*.exe" -File -Recurse |
    Where-Object { $_.Name -notlike "*Uninstall*" } |
    Select-Object -First 1
  Assert-Condition ($null -ne $appExe) "Installed 456code executable is missing."
  $resourcesDir = Join-Path $installDir "resources"
  Assert-Condition (Test-Path (Join-Path $resourcesDir "server.asar")) "Installed server.asar is missing."
  Assert-Condition (Test-Path (Join-Path $resourcesDir "server.asar.sha256")) "Installed server.asar digest is missing."

  Write-AcceptancePhase "packaged-smoke"
  $smokeExitCode = Invoke-BoundedProcess `
    -FilePath $appExe.FullName `
    -ArgumentList @(
      "--no-global-search-paths",
      (Join-Path $PSScriptRoot "windows-desktop-packaged-smoke.mjs"),
      $installDir
    ) `
    -Description "Packaged native/Cartographer smoke" `
    -TimeoutSeconds 300 `
    -NoNewWindow `
    -Environment @{ ELECTRON_RUN_AS_NODE = "1" }
  Assert-Condition ($smokeExitCode -eq 0) "Packaged native/Cartographer smoke exited $smokeExitCode."

  $appUpdateYml = Get-Content (Join-Path $resourcesDir "app-update.yml") -Raw
  $cacheMatch = [regex]::Match($appUpdateYml, "(?m)^updaterCacheDirName:\s*(.+?)\s*$")
  Assert-Condition $cacheMatch.Success "app-update.yml does not declare updaterCacheDirName."
  $cacheDir = Join-Path $localAppDataDir $cacheMatch.Groups[1].Value.Trim()
  Seed-CurrentInstallerCache $cacheDir $installerN.FullName

  Set-Content $feedLog ""
  Write-AcceptancePhase "differential-update"
  $firstRun = Start-AcceptanceApp $appExe.FullName 9331 $userDataDir
  try {
    $bootstraps = Invoke-BridgeJson $firstRun.Socket "window.desktopBridge.getLocalEnvironmentBootstraps()" 30
    $primary = @($bootstraps | Where-Object { $_.id -eq "local" -or $_.httpBaseUrl }) | Select-Object -First 1
    Assert-Condition ($null -ne $primary) "The packaged primary backend did not publish a bootstrap."
    $readyUrl = ([Uri]$primary.httpBaseUrl).AbsoluteUri.TrimEnd("/") + "/.well-known/t3/environment"
    $readyResponse = Invoke-WebRequest $readyUrl -TimeoutSec 10
    Assert-Condition ($readyResponse.StatusCode -eq 200) "Packaged backend readiness returned $($readyResponse.StatusCode)."

    $check = Invoke-BridgeJson $firstRun.Socket "await window.desktopBridge.checkForUpdate()" 60
    Assert-Condition $check.checked "The differential update check was not executed."
    $available = Wait-ForUpdateStatus $firstRun.Socket "available"
    Assert-Condition ($available.availableVersion -eq $VersionN1) "Expected update $VersionN1, received $($available.availableVersion)."
    $download = Invoke-BridgeJson $firstRun.Socket "await window.desktopBridge.downloadUpdate()" 300
    Assert-Condition ($download.accepted -and $download.completed) "Differential update download did not complete."
    Wait-ForUpdateStatus $firstRun.Socket "downloaded" | Out-Null
  } finally {
    $firstRun.Socket.Dispose()
    Stop-InstalledAppProcesses $installDir
    $firstRun.Process.Dispose()
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

  Write-AcceptancePhase "full-update-fallback"
  $fallbackRun = Start-AcceptanceApp $appExe.FullName 9332 $userDataDir
  try {
    $check = Invoke-BridgeJson $fallbackRun.Socket "await window.desktopBridge.checkForUpdate()" 60
    Assert-Condition $check.checked "The fallback update check was not executed."
    Wait-ForUpdateStatus $fallbackRun.Socket "available" | Out-Null
    $download = Invoke-BridgeJson $fallbackRun.Socket "await window.desktopBridge.downloadUpdate()" 300
    Assert-Condition ($download.accepted -and $download.completed) "Fallback update download did not complete."
    Wait-ForUpdateStatus $fallbackRun.Socket "downloaded" | Out-Null
    Assert-Condition (-not (Test-Path (Join-Path $pendingDir "stale-payload.tmp"))) "Updater did not clean the stale pending payload."
    $preInstallProcessIds = @(Get-InstalledExecutableProcessIds $appExe.FullName)
    Assert-Condition ($preInstallProcessIds.Count -gt 0) "No installed app process was present before updater installation."
    try {
      Invoke-CdpExpression $fallbackRun.Socket "void window.desktopBridge.installUpdate(); 'started'" $false 30 | Out-Null
    } catch {
      if (-not $fallbackRun.Process.HasExited) {
        throw
      }
    }
  } finally {
    $fallbackRun.Socket.Dispose()
    $fallbackRun.Process.Dispose()
  }

  $fallbackLog = Read-FeedLog $feedLog
  Assert-Condition (@($fallbackLog | Where-Object { $_.path -eq "/$($blockmapN.Name)" -and $_.status -eq 404 }).Count -gt 0) "Fallback path did not observe the missing N blockmap."
  Assert-Condition (@($fallbackLog | Where-Object {
    $rangeProperty = $_.PSObject.Properties["range"]
    $_.path -eq "/$($installerN1.Name)" -and
      $_.status -eq 200 -and
      ($null -eq $rangeProperty -or -not $rangeProperty.Value)
  }).Count -gt 0) "Fallback path did not download the complete installer."

  Write-AcceptancePhase "updater-relaunch"
  Wait-Until -Description "updater-triggered N+1 relaunch" -TimeoutSeconds 180 -Probe {
    $currentProcessIds = @(Get-InstalledExecutableProcessIds $appExe.FullName)
    $oldProcessIds = @($currentProcessIds | Where-Object { $preInstallProcessIds -contains $_ })
    $newProcessIds = @($currentProcessIds | Where-Object { $preInstallProcessIds -notcontains $_ })
    return $oldProcessIds.Count -eq 0 -and $newProcessIds.Count -gt 0
  }
  Stop-InstalledAppProcesses $installDir

  Write-AcceptancePhase "verify-n1"
  $updatedRun = Start-AcceptanceApp $appExe.FullName 9333 $userDataDir
  try {
    $state = Invoke-BridgeJson $updatedRun.Socket "await window.desktopBridge.getUpdateState()" 30
    Assert-Condition ($state.currentVersion -eq $VersionN1) "Relaunched app reports $($state.currentVersion), expected $VersionN1."
    $bootstraps = Invoke-BridgeJson $updatedRun.Socket "window.desktopBridge.getLocalEnvironmentBootstraps()" 30
    Assert-Condition (@($bootstraps).Count -gt 0) "Updated app did not start its packaged backend."
  } finally {
    $updatedRun.Socket.Dispose()
    Stop-InstalledAppProcesses $installDir
    $updatedRun.Process.Dispose()
  }

  Write-AcceptancePhase "uninstall"
  $uninstaller = Get-ChildItem $installDir -Filter "Uninstall*.exe" -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $uninstaller) "Installed uninstaller is missing."
  $uninstallExitCode = Invoke-BoundedProcess `
    -FilePath $uninstaller.FullName `
    -ArgumentList @("/S") `
    -Description "Silent uninstall" `
    -TimeoutSeconds 180
  Assert-Condition ($uninstallExitCode -eq 0) "Silent uninstall exited $uninstallExitCode."
  Wait-Until -Description "installed directory cleanup" -TimeoutSeconds 60 -Probe {
    return -not (Test-Path $installDir)
  }
  Remove-Item $stateDir, $userDataDir, $cacheDir -Recurse -Force -ErrorAction SilentlyContinue
  Assert-Condition (-not (Test-Path $stateDir)) "Acceptance state directory was not cleaned."

  Write-AcceptancePhase "complete"
  Write-Host "Windows desktop acceptance passed: install, packaged backend, PTY/fff/Cartographer, differential range update, full fallback, stale cleanup, N+1 relaunch, uninstall."
} finally {
  Write-AcceptancePhase "cleanup"
  try {
    Stop-InstalledAppProcesses $installDir
  } catch {
    Write-Warning "Installed-process cleanup failed: $($_.Exception.Message)"
  }
  if ($feedProcess) {
    Stop-ProcessTree $feedProcess
    $feedProcess.Dispose()
  }
  if (Test-Path $feedStderr) {
    Get-Content $feedStderr | ForEach-Object { Write-Host $_ }
  }
}
