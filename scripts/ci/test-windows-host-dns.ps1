param([string]$FixturePath = '/fixtures')
$ErrorActionPreference = 'Stop'
foreach ($name in @('start.ps1','verify.ps1','verify-ad.ps1')) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $FixturePath $name),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
New-PSDrive -Name C -PSProvider FileSystem -Root $FixturePath | Out-Null
function Get-Command {
  param([string]$Name,[object]$ErrorAction)
  if ($script:mode -eq 'legacy' -and $Name -match '^Get-(NetIPAddress|DnsClientServerAddress)$') { return $null }
  Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
}
function Get-NetIPAddress {
  param([string]$AddressFamily,[object]$ErrorAction)
  $ips = @('10.0.1.20','10.0.2.20')
  if ($script:mode -eq 'ambiguous') { $ips = @('10.0.2.20','10.0.2.20') }
  if ($script:mode -eq 'alias-same-index') { $ips = @('10.0.2.20','10.0.2.21') }
  for ($i=0; $i -lt $ips.Count; $i++) { [PSCustomObject]@{IPAddress=$ips[$i];InterfaceIndex=$(if ($script:mode -eq 'alias-same-index') { 12 } else { $i+11 })} }
}
function Get-DnsClientServerAddress {
  param([int]$InterfaceIndex,[string]$AddressFamily,[object]$ErrorAction)
  [PSCustomObject]@{ServerAddresses=@($script:servers[$InterfaceIndex])}
}
function Set-DnsClientServerAddress {
  param([int]$InterfaceIndex,[string[]]$ServerAddresses,[object]$ErrorAction)
  if ($script:mode -eq 'set-failed') { throw 'A deliberately sensitive vendor error should not escape the report' }
  $script:configured += $InterfaceIndex; $script:servers[$InterfaceIndex] = @($ServerAddresses)
}
function Get-WmiObject {
  param([string]$Class,[string]$Filter,[object]$ErrorAction)
  $nic = [PSCustomObject]@{IPAddress=@('10.0.2.20');InterfaceIndex=42;DNSServerSearchOrder=@($script:servers[42])}
  $nic | Add-Member -MemberType ScriptMethod -Name SetDNSServerSearchOrder -Value {
    param([string[]]$value)
    $script:configured += 42; $script:servers[42] = @($value)
    [PSCustomObject]@{ReturnValue=0}
  }
  $nic
}
function Invoke-Case([string]$Mode,[string]$File,[string]$ExpectedStatus,[string]$ExpectedError = '') {
  $script:mode = $Mode; $script:servers = @{11=@('8.8.8.8');12=@('10.0.1.10');42=@('8.8.8.8')}; $script:configured = @()
  if ($Mode -eq 'readback-mismatch') { $script:servers[12]=@('8.8.8.8') }
  if ($Mode -like 'ad-*') { $script:servers[12]=@('127.0.0.1') }
  $output = @(& { try { . (Join-Path $FixturePath $File) } catch { } })
  $lines = @($output | Where-Object { $_ -is [string] -and $_.StartsWith('CYBER_RANGE_DNS_RESULT:') })
  if ($lines.Count -ne 1) { throw "Expected one bounded report for $Mode, received $($lines.Count)" }
  $report = $lines[0].Substring('CYBER_RANGE_DNS_RESULT:'.Length) | ConvertFrom-Json
  if ($report.status -ne $ExpectedStatus -or $report.verificationNonce -ne 'nonce-docker') { throw "Wrong report for $Mode" }
  if ($ExpectedError -and $report.errorCode -ne $ExpectedError) { throw "Wrong failure code for $Mode" }
  if ($ExpectedStatus -eq 'failed' -and $output -contains 'USER_INITIALIZATION') { throw "User initialization ran after DNS failure in $Mode" }
  if ($File -eq 'verify.ps1' -and $script:configured.Count) { throw 'Readonly verification changed DNS' }
  if ($Mode -eq 'modern' -and $File -eq 'start.ps1' -and ($script:configured.Count -ne 1 -or $script:configured[0] -ne 12)) { throw 'Primary NIC was configured accidentally' }
  if ($ExpectedStatus -eq 'verified' -and $report.interfaces[0].nicId -ne 'nic-secondary') { throw 'Wrong target NIC' }
  "PASS $Mode $File $ExpectedStatus"
}
Invoke-Case modern start.ps1 verified
Invoke-Case legacy start.ps1 verified
Invoke-Case modern verify.ps1 verified
Invoke-Case readback-mismatch verify.ps1 failed DNS_READBACK_MISMATCH
Invoke-Case ambiguous start.ps1 failed NIC_AMBIGUOUS
Invoke-Case set-failed start.ps1 failed DNS_CONFIGURATION_FAILED
$aliasScript = Get-Content (Join-Path $FixturePath 'verify.ps1') -Raw
$aliasScript = $aliasScript.Replace("$" + "dnsTargets = @(@{nicId='nic-secondary';privateIp='10.0.2.20'})", "$" + "dnsTargets = @(@{nicId='nic-secondary';privateIp='10.0.2.20'},@{nicId='nic-other';privateIp='10.0.2.21'})")
Set-Content -Path (Join-Path $FixturePath 'verify-alias.ps1') -Value $aliasScript
Invoke-Case alias-same-index verify-alias.ps1 failed NIC_AMBIGUOUS
$server = Start-Job -ScriptBlock {
  $udp = [Net.Sockets.UdpClient]::new(53)
  $udp.Client.ReceiveTimeout = 10000
  try {
    for ($i=0; $i -lt 3; $i++) {
      $peer = [Net.IPEndPoint]::new([Net.IPAddress]::Any,0); $request = $udp.Receive([ref]$peer)
      $header = [byte[]]@(66,83,132,128,0,1,0,1,0,0,0,0)
      $question = $request[12..($request.Length-1)]
      $answer = [byte[]]@(192,12,0,33,0,1,0,0,0,60,0,23,0,0,0,0,1,133,3,100,99,49,3,108,97,98,7,101,120,97,109,112,108,101,0)
      if ($i -eq 1) { $header[3]=131; $header[7]=0; $answer=@() }
      if ($i -eq 2) { $header[2]=134; $header[7]=0; $answer=@() }
      $reply = [byte[]]($header+$question+$answer); [void]$udp.Send($reply,$reply.Length,$peer)
    }
  } finally { $udp.Close() }
}
$tcpServer = Start-Job -ScriptBlock {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,53); $listener.Start()
  try {
    $client = $listener.AcceptTcpClient(); $stream = $client.GetStream(); $stream.ReadTimeout = 5000
    $prefix = [byte[]]::new(2); if ($stream.Read($prefix,0,2) -ne 2) { throw 'Invalid TCP prefix' }
    $size = [int]$prefix[0]*256+[int]$prefix[1]; $request = [byte[]]::new($size); $offset=0
    while ($offset -lt $size) { $count=$stream.Read($request,$offset,$size-$offset); if ($count -lt 1) { throw 'TCP EOF' }; $offset+=$count }
    $header = [byte[]]@(66,83,132,128,0,1,0,1,0,0,0,0); $question = $request[12..($request.Length-1)]
    $answer = [byte[]]@(192,12,0,33,0,1,0,0,0,60,0,23,0,0,0,0,1,133,3,100,99,49,3,108,97,98,7,101,120,97,109,112,108,101,0)
    $reply = [byte[]]($header+$question+$answer); $frame = [byte[]]@([byte]($reply.Length -shr 8),[byte]($reply.Length -band 255)) + $reply
    $stream.Write($frame,0,$frame.Length); $client.Close()
  } finally { $listener.Stop() }
}
try {
  Start-Sleep -Seconds 2
  Invoke-Case ad-success verify-ad.ps1 verified
  Invoke-Case ad-nxdomain verify-ad.ps1 failed DNS_SRV_FAILED
  Invoke-Case ad-tcp-fallback verify-ad.ps1 verified
  $server | Wait-Job -Timeout 10 | Out-Null
  if ($server.State -ne 'Completed') { throw 'Local DNS fixture server did not complete' }
  $server | Receive-Job -ErrorAction Stop | Out-Null
  $tcpServer | Wait-Job -Timeout 10 | Out-Null
  if ($tcpServer.State -ne 'Completed') { throw 'Local TCP DNS fixture did not complete' }
  $tcpServer | Receive-Job -ErrorAction Stop | Out-Null
} finally { @($server,$tcpServer) | Stop-Job; @($server,$tcpServer) | Remove-Job -Force }
'PowerShell mocked networking checks complete; this is not a Windows VM test.'
