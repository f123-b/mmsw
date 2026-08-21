param(
  [ValidateSet("q8", "q4")]
  [string]$Quant = "q8",
  [int]$ChunkSizeMiB = 1,
  [int]$WorkerCount = 16
)

$serviceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\apps\local-asr-service")).Path
$runtimeRoot = Join-Path $serviceRoot "openasr-runtime\openasr-0.1.30-windows-x86_64"
$catalogPath = Join-Path $runtimeRoot "model-registry\catalog.json"
$openAsrHomePath = Join-Path $serviceRoot "openasr-home"
$modelDirectory = Join-Path $openAsrHomePath "models"
$catalog = Get-Content $catalogPath -Raw | ConvertFrom-Json
$model = $catalog.models | Where-Object { $_.id -eq "funasr-nano" }
$quantization = if ($Quant -eq "q8") { "q8_0" } else { "q4_k" }
$pack = $model.quants | Where-Object { $_.quant -eq $quantization }
if (-not $pack) { throw "No Fun-ASR-Nano pack found for $Quant" }

$expectedBytes = [int64]$pack.size_bytes
$expectedHash = $pack.sha256.ToLower()
$downloadUrl = $pack.url
$outputPath = Join-Path $modelDirectory $pack.filename
$chunkDirectory = Join-Path $modelDirectory ("download-{0}-chunks" -f $Quant)
$backupDirectory = Join-Path $modelDirectory "interrupted-downloads"
New-Item -ItemType Directory -Force -Path $modelDirectory, $chunkDirectory, $backupDirectory | Out-Null

if (Test-Path -LiteralPath $outputPath) {
  $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLower()
  if ($existingHash -eq $expectedHash) {
    Write-Output "$Quant already verified: $outputPath"
    exit 0
  }
  Move-Item -LiteralPath $outputPath -Destination $backupDirectory -Force
}

$chunkSize = [int64]($ChunkSizeMiB * 1MB)
$chunkCount = [int][math]::Ceiling($expectedBytes / $chunkSize)
$pendingChunks = [System.Collections.Generic.List[int]]::new()
for ($chunkIndex = 0; $chunkIndex -lt $chunkCount; $chunkIndex++) {
  $rangeStart = [int64]($chunkIndex * $chunkSize)
  $rangeEnd = [int64][math]::Min($expectedBytes - 1, $rangeStart + $chunkSize - 1)
  $expectedChunkBytes = $rangeEnd - $rangeStart + 1
  $chunkPath = Join-Path $chunkDirectory ("part-{0:D2}.bin" -f $chunkIndex)
  if ((Test-Path -LiteralPath $chunkPath) -and ((Get-Item -LiteralPath $chunkPath).Length -eq $expectedChunkBytes)) {
    continue
  }
  if (Test-Path -LiteralPath $chunkPath) { Move-Item -LiteralPath $chunkPath -Destination $backupDirectory -Force }

  $pendingChunks.Add($chunkIndex)
}

for ($batchStart = 0; $batchStart -lt $pendingChunks.Count; $batchStart += $WorkerCount) {
  $processes = @()
  $batchEnd = [math]::Min($pendingChunks.Count, $batchStart + $WorkerCount)
  for ($pendingIndex = $batchStart; $pendingIndex -lt $batchEnd; $pendingIndex++) {
    $chunkIndex = $pendingChunks[$pendingIndex]
    $rangeStart = [int64]($chunkIndex * $chunkSize)
    $rangeEnd = [int64][math]::Min($expectedBytes - 1, $rangeStart + $chunkSize - 1)
    $expectedChunkBytes = $rangeEnd - $rangeStart + 1
    $chunkPath = Join-Path $chunkDirectory ("part-{0:D2}.bin" -f $chunkIndex)

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = "curl.exe"
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardError = $true
    $arguments = @(
      "-L", "--http1.1", "--fail", "--retry", "2", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "15", "--max-time", "45", "--retry-max-time", "120",
      "--range", ("{0}-{1}" -f $rangeStart, $rangeEnd),
      "--output", $chunkPath,
      $downloadUrl
    )
    foreach ($argument in $arguments) { [void]$processInfo.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    [void]$process.Start()
    $processes += [pscustomobject]@{
      Index = $chunkIndex
      Process = $process
      Path = $chunkPath
      Expected = $expectedChunkBytes
    }
  }

  while ($processes | Where-Object { -not $_.Process.HasExited }) {
    $downloadedBytes = [int64]0
    foreach ($job in $processes) {
      if (Test-Path -LiteralPath $job.Path) { $downloadedBytes += (Get-Item -LiteralPath $job.Path).Length }
    }
    foreach ($completedChunk in Get-ChildItem -LiteralPath $chunkDirectory -Filter "part-*.bin" -File -ErrorAction SilentlyContinue) {
      $downloadedBytes += 0
    }
    Write-Output ("{0} parallel download: {1:N1}/{2:N1} MiB (batch {3}/{4})" -f $Quant, ($downloadedBytes / 1MB), ($expectedBytes / 1MB), [math]::Min($batchEnd, $pendingChunks.Count), $pendingChunks.Count)
    Start-Sleep -Seconds 5
  }

  foreach ($job in $processes) {
    if ($job.Process.ExitCode -ne 0) {
      $errorText = $job.Process.StandardError.ReadToEnd()
      throw ("{0} chunk {1} failed with exit {2}: {3}" -f $Quant, $job.Index, $job.Process.ExitCode, $errorText)
    }
    $actualChunkBytes = (Get-Item -LiteralPath $job.Path).Length
    if ($actualChunkBytes -ne $job.Expected) {
      throw ("{0} chunk {1} size mismatch: {2} vs {3}" -f $Quant, $job.Index, $actualChunkBytes, $job.Expected)
    }
  }
}

$outputStream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
  for ($chunkIndex = 0; $chunkIndex -lt $chunkCount; $chunkIndex++) {
    $chunkPath = Join-Path $chunkDirectory ("part-{0:D2}.bin" -f $chunkIndex)
    $inputStream = [System.IO.File]::OpenRead($chunkPath)
    try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
  }
} finally {
  $outputStream.Dispose()
}

$actualBytes = (Get-Item -LiteralPath $outputPath).Length
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLower()
Write-Output ("{0} complete: {1} bytes, sha256={2}" -f $Quant, $actualBytes, $actualHash)
if ($actualBytes -ne $expectedBytes -or $actualHash -ne $expectedHash) {
  throw "$Quant final verification failed"
}
