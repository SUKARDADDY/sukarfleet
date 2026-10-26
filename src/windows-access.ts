// SPDX-License-Identifier: AGPL-3.0-or-later
// Native Windows SSH access. The payload travels on stdin, avoiding cmd.exe's 8191-character
// command-line limit and keeping user argv out of either remote shell's parser.
// A suspended child joins a kill-on-close Job Object BEFORE its first instruction. Closing
// the wrapper, completing normally or reaching the deadline kills descendants too.
const JOB_RUNNER = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class FleetJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic BasicLimitInformation; public Io IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize; public IntPtr reserved2,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,uint n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint c);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint c);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint c);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  // CommandLineToArgvW / CRT quoting, including empty arguments and trailing backslashes.
  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) {
      if(c=='\\') { slashes++; continue; }
      b.Append('\\',c=='"' ? slashes*2+1 : slashes); b.Append(c); slashes=0;
    }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string exe,string[] args,int seconds) {
    uint deadline=checked((uint)seconds*1000);
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    var pi=new ProcessInfo(); bool started=false;
    try {
      var limits=new Limits(); limits.BasicLimitInformation.LimitFlags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
      var cmd=new StringBuilder(Quote(exe)); foreach(string a in args) cmd.Append(" "+Quote(a));
      if(cmd.Length>=32767) throw new ArgumentException("Windows command line exceeds 32766 characters");
      var si=new Startup(); si.cb=Marshal.SizeOf(typeof(Startup)); si.flags=0x100;
      si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
      Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,null,ref si,out pi));
      started=true;
      Check(AssignProcessToJobObject(job,pi.process));
      Check(ResumeThread(pi.thread)!=0xffffffff);
      uint wait=WaitForSingleObject(pi.process,deadline);
      if(wait==258) { Check(TerminateJobObject(job,124)); WaitForSingleObject(pi.process,5000); return 124; }
      Check(wait==0); uint code; Check(GetExitCodeProcess(pi.process,out code)); return unchecked((int)code);
    } finally {
      // If assignment failed, the suspended process is outside the job and must be killed directly.
      if(started) { TerminateProcess(pi.process,125); CloseHandle(pi.thread); CloseHandle(pi.process); }
      CloseHandle(job);
    }
  }
}`;

export const WINDOWS_BOOTSTRAP = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' +
  Buffer.from('$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";try{& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))}catch{[Console]::Error.WriteLine($_.Exception.Message);[Environment]::Exit(126)}', 'utf16le').toString('base64');

export function windowsRunPayload(argv: string[], timeoutSec: number, runId: string): string {
  const payload = Buffer.from(JSON.stringify({ argv, timeoutSec, runId }), 'utf8').toString('base64');
  return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
Add-Type -TypeDefinition @'
${JOB_RUNNER}
'@
$a=[string]$p.argv[0]
if($a.IndexOfAny([char[]]'\\/:') -ge 0){$src=(Get-Item -LiteralPath $a -ErrorAction Stop).FullName}
elseif($a.IndexOfAny([char[]]'[]*?') -lt 0){$src=(Get-Command -Name $a -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source}
else{$src=$null;$exts=@('')+@(([string]$env:PATHEXT).Split(';')|Where-Object{$_})
foreach($d in ([string]$env:PATH).Split([IO.Path]::PathSeparator)){if(-not $d){continue};foreach($x in $exts){$c=Join-Path $d ($a+$x);if([IO.File]::Exists($c)){$src=$c;break}};if($src){break}}
if(-not $src){throw "executable not found on PATH: $a"}}
if([IO.Path]::GetExtension($src) -notin @('.exe','.com')){throw 'Use cmd.exe explicitly for batch files'}
$rest=New-Object 'System.Collections.Generic.List[string]'
for($i=1;$i -lt $p.argv.Count;$i++){$rest.Add([string]$p.argv[$i])}
# The outer SSH shell can collapse nonzero native exits to 1. Emit a completion record only
# after the job has closed. The origin retains this bounded suffix separately from stderr.
$code=[FleetJob]::Run($src,$rest.ToArray(),[int]$p.timeoutSec)
[Console]::Error.WriteLine(([Environment]::NewLine+'FLEET-WINDOWS-'+$p.runId+':'+$code))
[Environment]::Exit(0)
`;
}

export function windowsExitCode(stderrTail: string, runId: string): number | null {
  const suffix = stderrTail.match(new RegExp(`(?:^|\\r?\\n)FLEET-WINDOWS-${runId}:(-?\\d+)\\r?\\n$`));
  if (!suffix) return null;
  const code = Number(suffix[1]);
  return Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : null;
}

export function stripWindowsCompletion(stderr: string, runId: string): string {
  return stderr.replace(new RegExp(`\\r?\\nFLEET-WINDOWS-${runId}:-?\\d+\\r?\\n$`), '');
}
