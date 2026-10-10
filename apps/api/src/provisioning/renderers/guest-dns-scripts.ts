import { isIPv4 } from 'node:net';
import { isHostDnsIpv4, type HostDnsConfig } from '@aliyun-cyber-range/scenario-runtime/compiled';

export type WindowsHostDnsConfig = HostDnsConfig;
export type WindowsDnsTarget = { nicId: string; privateIp: string };
type DnsScriptInput = { dns: WindowsHostDnsConfig; interfaces: WindowsDnsTarget[]; verificationNonce?: string };
export const WINDOWS_DNS_RESULT_PREFIX = 'CYBER_RANGE_DNS_RESULT:';

function selectedTargets(input: DnsScriptInput) {
  const { dns, interfaces } = input;
  if (input.verificationNonce !== undefined && !/^[a-z0-9-]{1,64}$/i.test(input.verificationNonce)) throw new Error('DNS verification nonce must be an opaque ASCII identifier');
  if (!dns.servers.length || dns.servers.length > 4 || new Set(dns.servers).size !== dns.servers.length || dns.servers.some(ip => !isHostDnsIpv4(ip))) throw new Error('Host DNS needs one to four distinct unicast IPv4 servers');
  if (!dns.nicIds.length || dns.nicIds.length > 16 || new Set(dns.nicIds).size !== dns.nicIds.length) throw new Error('Host DNS needs distinct target NIC IDs');
  if (dns.domain && (dns.domain.length > 253 || !dns.domain.includes('.') || dns.domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) throw new Error('Host DNS domain must be an ASCII DNS domain');
  const targets = dns.nicIds.map(nicId => {
    const targets = interfaces.filter(nic => nic.nicId === nicId);
    if (targets.length !== 1 || !isIPv4(targets[0].privateIp) || typeof nicId !== 'string' || !nicId.length || nicId.length > 128 || /[\x00-\x1f\x7f]/.test(nicId)) throw new Error('Host DNS target must reference one explicit NIC with a private IPv4 address');
    return targets[0];
  });
  if (new Set(targets.map(target => target.privateIp)).size !== targets.length) throw new Error('Host DNS target NICs must have distinct private IPv4 addresses');
  return targets;
}

function psString(value: string) { return `'${value.replace(/'/g, "''")}'`; }
function psArray(values: string[]) { return `@(${values.map(psString).join(',')})`; }

function dnsScript(input: DnsScriptInput, configure: boolean) {
  const targets = selectedTargets(input);
  // PS 2.0 has no ConvertTo-Json; the small serializer also keeps the protocol identical on 2008 R2.
  return `$ErrorActionPreference = 'Stop'
$dnsTargets = @(${targets.map(target => `@{nicId=${psString(target.nicId)};privateIp=${psString(target.privateIp)}}`).join(',')})
$dnsExpected = ${psArray(input.dns.servers)}
$dnsDomain = ${psString(configure ? '' : input.dns.domain ?? '')}
function Convert-DnsJson($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { return $v.ToString().ToLowerInvariant() }
  if ($v -is [string]) {
    $s = $v.Replace('\\','\\\\').Replace('"','\\"').Replace([string][char]13,'\\r').Replace([string][char]10,'\\n').Replace([string][char]9,'\\t')
    return '"' + $s + '"'
  }
  if ($v -is [System.Collections.IDictionary]) {
    $pairs = @(); foreach ($k in $v.Keys) { $pairs += (Convert-DnsJson ([string]$k)) + ':' + (Convert-DnsJson $v[$k]) }
    return '{' + ($pairs -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $items = @(); foreach ($item in $v) { $items += Convert-DnsJson $item }; return '[' + ($items -join ',') + ']'
  }
  return [string]$v
}
function Find-DnsAdapter($ip) {
  if ((Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) -and (Get-Command Get-DnsClientServerAddress -ErrorAction SilentlyContinue)${configure ? ' -and (Get-Command Set-DnsClientServerAddress -ErrorAction SilentlyContinue)' : ''}) {
    $matches = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -eq $ip })
    if ($matches.Count -gt 1) { throw 'NIC_AMBIGUOUS' }; if ($matches.Count -eq 0) { return $null }
    return @{ index=[int]$matches[0].InterfaceIndex; modern=$true }
  }
  $matches = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction Stop | Where-Object { @($_.IPAddress) -contains $ip })
  if ($matches.Count -gt 1) { throw 'NIC_AMBIGUOUS' }; if ($matches.Count -eq 0) { return $null }
  return @{ index=[int]$matches[0].InterfaceIndex; modern=$false; config=$matches[0] }
}
function Read-DnsServers($adapter) {
  if ($adapter.modern) { return @((Get-DnsClientServerAddress -InterfaceIndex $adapter.index -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses) }
  $current = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $adapter.index })
  if ($current.Count -ne 1) { throw 'NIC_NOT_READY' }; return @($current[0].DNSServerSearchOrder)
}
function Read-DnsUInt16($bytes, $offset) {
  if ($offset -lt 0 -or $offset + 1 -ge $bytes.Length) { throw 'DNS_INVALID_RESPONSE' }
  return ([int]$bytes[$offset] * 256 + [int]$bytes[$offset+1])
}
function Skip-DnsName($bytes, $offset) {
  for ($steps = 0; $steps -lt 128; $steps++) {
    if ($offset -ge $bytes.Length) { throw 'DNS_INVALID_RESPONSE' }; $length = [int]$bytes[$offset]
    if ($length -eq 0) { return $offset + 1 }
    if (($length -band 192) -eq 192) { if ($offset+1 -ge $bytes.Length) { throw 'DNS_INVALID_RESPONSE' }; return $offset + 2 }
    if ($length -gt 63) { throw 'DNS_INVALID_RESPONSE' }; $offset += $length + 1
  }; throw 'DNS_INVALID_RESPONSE'
}
function Read-DnsTcpBytes($stream, $size, $deadline) {
  $bytes = New-Object byte[] $size; $offset = 0
  while ($offset -lt $size) {
    $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remaining -lt 1) { throw 'DNS_QUERY_TIMEOUT' }; $stream.ReadTimeout = $remaining
    $read = $stream.Read($bytes,$offset,$size-$offset); if ($read -lt 1) { throw 'DNS_INVALID_RESPONSE' }; $offset += $read
  }; return ,$bytes
}
function Query-DnsTcp($server, $packet) {
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $connect = $tcp.BeginConnect($server,53,$null,$null)
    try { if (-not $connect.AsyncWaitHandle.WaitOne(3000)) { throw 'DNS_QUERY_TIMEOUT' }; $tcp.EndConnect($connect) } finally { $connect.AsyncWaitHandle.Close() }
    $stream = $tcp.GetStream(); $stream.WriteTimeout = 3000
    $frame = [byte[]]@([byte]($packet.Length -shr 8),[byte]($packet.Length -band 255)) + $packet; $stream.Write($frame,0,$frame.Length)
    $deadline = [DateTime]::UtcNow.AddSeconds(3); $length = Read-DnsTcpBytes $stream 2 $deadline; $size = Read-DnsUInt16 $length 0
    if ($size -lt 12 -or $size -gt 16384) { throw 'DNS_INVALID_RESPONSE' }; return ,(Read-DnsTcpBytes $stream $size $deadline)
  } finally { $tcp.Close() }
}
function Test-DnsSrv($server, $domain) {
  $query = New-Object System.Collections.Generic.List[byte]
  $query.AddRange([byte[]]@(66,83,1,0,0,1,0,0,0,0,0,0))
  foreach ($label in ('_ldap._tcp.dc._msdcs.' + $domain).Split('.')) { $encoded = [Text.Encoding]::ASCII.GetBytes($label); $query.Add([byte]$encoded.Length); $query.AddRange($encoded) }
  $query.AddRange([byte[]]@(0,0,33,0,1)); $packet = $query.ToArray()
  $udp = New-Object Net.Sockets.UdpClient
  try {
    $udp.Client.ReceiveTimeout = 3000; $udp.Client.SendTimeout = 3000; $udp.Connect($server,53)
    [void]$udp.Send($packet,$packet.Length); $peer = New-Object Net.IPEndPoint ([Net.IPAddress]::Any,0); $reply = $udp.Receive([ref]$peer)
    if ($reply.Length -ge 12 -and ($reply[2] -band 2) -ne 0) { $reply = Query-DnsTcp $server $packet }
    if ($reply.Length -lt 12 -or (Read-DnsUInt16 $reply 0) -ne 16979 -or ($reply[2] -band 128) -eq 0 -or ($reply[2] -band 122) -ne 0 -or ($reply[3] -band 15) -ne 0 -or (Read-DnsUInt16 $reply 4) -ne 1) { throw 'DNS_INVALID_RESPONSE' }
    $answerCount = Read-DnsUInt16 $reply 6; if ($answerCount -gt 128) { throw 'DNS_INVALID_RESPONSE' }
    $offset = (Skip-DnsName $reply 12) + 4; $count = 0
    for ($i=0; $i -lt $answerCount; $i++) {
      $offset = Skip-DnsName $reply $offset; $type = Read-DnsUInt16 $reply $offset; $class = Read-DnsUInt16 $reply ($offset+2); $size = Read-DnsUInt16 $reply ($offset+8); $offset += 10
      if ($offset + $size -gt $reply.Length) { throw 'DNS_INVALID_RESPONSE' }
      if ($type -eq 33 -and $class -eq 1 -and $size -ge 7 -and (Read-DnsUInt16 $reply ($offset+4)) -gt 0 -and $reply[$offset+6] -ne 0) { $count++ }
      $offset += $size
    }
    if ($count -lt 1) { throw 'DNS_SRV_NOT_FOUND' }; return $count
  } finally { $udp.Close() }
}
$dnsResult = @{schemaVersion=1;status='failed';method='${!configure && input.dns.domain ? 'ad_srv' : 'readback'}';interfaces=@();probes=@()${input.verificationNonce ? `;verificationNonce=${psString(input.verificationNonce)}` : ''}}
try {
  $dnsNicDeadline = [DateTime]::UtcNow.AddSeconds(${configure ? 120 : 10})
  foreach ($target in $dnsTargets) {
    $adapter = $null
    do { $adapter = Find-DnsAdapter $target.privateIp; if ($null -eq $adapter) { Start-Sleep -Seconds 2 } } while ($null -eq $adapter -and [DateTime]::UtcNow -lt $dnsNicDeadline)
    if ($null -eq $adapter) { throw 'NIC_NOT_READY' }
${configure ? `    if ($adapter.modern) { Set-DnsClientServerAddress -InterfaceIndex $adapter.index -ServerAddresses $dnsExpected -ErrorAction Stop }
    else { $set = $adapter.config.SetDNSServerSearchOrder([string[]]$dnsExpected); if ($set.ReturnValue -ne 0) { throw 'DNS_SET_FAILED' } }
` : ''}    $actual = @(Read-DnsServers $adapter); $matched = ($actual.Count -eq $dnsExpected.Count -and ($actual -join ',') -eq ($dnsExpected -join ','))
    $dnsResult.interfaces += @{nicId=$target.nicId;privateIp=$target.privateIp;interfaceIndex=$adapter.index;expectedServers=@($dnsExpected);actualServers=@($actual);matched=$matched}
    if (-not $matched) { throw 'DNS_READBACK_MISMATCH' }
  }
  if ($dnsDomain -ne '') {
    foreach ($server in $dnsExpected) {
      try { $count = Test-DnsSrv $server $dnsDomain; $dnsResult.probes += @{server=$server;status='verified';recordCount=$count} }
      catch { $dnsResult.probes += @{server=$server;status='failed';recordCount=0}; throw 'DNS_SRV_FAILED' }
    }
  }
  $dnsResult.status = 'verified'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^(NIC_AMBIGUOUS|NIC_NOT_READY|DNS_SET_FAILED|DNS_READBACK_MISMATCH|DNS_SRV_FAILED)$') { $code = 'DNS_CONFIGURATION_FAILED' }
  $dnsResult.errorCode = $code
}
$dnsJson = Convert-DnsJson $dnsResult
${configure ? `New-Item -ItemType Directory -Path 'C:\\ProgramData\\cyber-range' -Force | Out-Null
[IO.File]::WriteAllText('C:\\ProgramData\\cyber-range\\dns-result.json',$dnsJson,(New-Object Text.UTF8Encoding($false)))
` : ''}Write-Output ('${WINDOWS_DNS_RESULT_PREFIX}' + $dnsJson)
if ($dnsResult.status -ne 'verified') { throw $dnsResult.errorCode }
`;
}

function powershellBody(script: { type: string; content: string }) {
  let content = script.content.replace(/^\uFEFF/, '').trim();
  if (!content) return '';
  if (script.type === 'cloud-init' || /^#!|^#cloud-config|^\[bat\]|^<script>/i.test(content)) throw new Error('Windows DNS cannot be combined with shell, batch or cloud-config user data');
  if (/^\[powershell\](?:\r?\n|$)/i.test(content)) content = content.replace(/^\[powershell\](?:\r?\n|$)/i, '');
  else if (/^<powershell>\s*[\s\S]*<\/powershell>$/i.test(content)) content = content.replace(/^<powershell>\s*/i, '').replace(/\s*<\/powershell>$/i, '');
  else if (/^#ps1_(?:sysnative|x86)(?:\r?\n|$)/i.test(content)) content = content.replace(/^#ps1_(?:sysnative|x86)(?:\r?\n|$)/i, '');
  else if (script.type !== 'powershell') throw new Error('Windows DNS user script requires a PowerShell header or explicit powershell type');
  if (/<\/?powershell>/i.test(content) || /^\s*(?:\[powershell\]|#ps1_|#!|#cloud-config)/im.test(content)) throw new Error('Windows DNS user data cannot contain multiple or mixed script headers');
  return content.trim();
}

export function buildWindowsDnsUserData(input: DnsScriptInput & { provider: 'alicloud' | 'tencent_cloud'; scripts: Array<{ type: string; content: string }> }) {
  const body = dnsScript(input, true) + input.scripts.map(powershellBody).filter(Boolean).join('\n\n');
  const content = input.provider === 'alicloud' ? `[powershell]\n${body}` : `<powershell>\n${body}\n</powershell>`;
  const limit = (input.provider === 'alicloud' ? 32 : 16) * 1024;
  if (Buffer.byteLength(content, 'utf8') > limit) throw new Error(`Windows DNS user data exceeds ${limit / 1024} KiB`);
  return content;
}

export function buildWindowsDnsVerificationScript(input: DnsScriptInput) { return dnsScript(input, false); }
