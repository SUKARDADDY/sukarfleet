; SPDX-License-Identifier: AGPL-3.0-or-later
;
; One installer, two scopes.
;
;   Per-user (the default)  installs exactly what install\windows\Add-To-Fleet.cmd installs: a
;                           node that belongs to one account, started by a scheduled task when
;                           that account logs on. The wizard collects the answers and hands them
;                           to Install-Sukarfleet.ps1, which is not edited by this installer.
;
;   Machine-wide (/ALLUSERS, or "Install for all users" in the dialog)
;                           installs a Windows service that is answering before anyone has
;                           logged on, with one identity for the whole PC and a shared root
;                           every account can work in. Install-MachineNode.ps1 does that work.
;
; Built by .github\workflows\installer-windows.yml. Compile it by hand with:
;   iscc install\windows\sukarfleet.iss
; which writes dist\sukarfleet-setup-windows-x86_64.exe.

#define SrcRoot "..\.."
#define AppVer "0.1.0"

[Setup]
; Fixed, and never regenerated: this GUID is how Windows recognises an upgrade of this
; installer rather than a second copy of it.
AppId={{9C2E7A54-3D8B-4F27-9A61-5E0C7B2D4A18}
AppName=sukarfleet
AppVersion={#AppVer}
VersionInfoVersion={#AppVer}
AppPublisher=sukarfleet
AppPublisherURL=https://github.com/SUKARDADDY/sukarfleet
UninstallDisplayName=sukarfleet
DefaultDirName={code:GetDefaultDir}
DefaultGroupName=sukarfleet
DisableProgramGroupPage=yes
; Ask for nothing by default, and let the operator (or a command line) ask for more. The scope
; dialog is what turns this one EXE into the two installs above.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
UsePreviousPrivileges=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
MinVersion=10.0
LicenseFile={#SrcRoot}\LICENSE
OutputDir={#SrcRoot}\dist
OutputBaseFilename=sukarfleet-setup-windows-x86_64
WizardStyle=modern
; So /LOG has something to say when a silent install on a machine nobody is watching goes wrong.
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The tree the node runs from. install\ travels with it because the node's own installer scripts
; live there and the machine-wide install calls Install-Sukarfleet.ps1 for the mesh transport.
Source: "{#SrcRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SrcRoot}\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SrcRoot}\install\*"; DestDir: "{app}\install"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SrcRoot}\LICENSES\*"; DestDir: "{app}\LICENSES"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SrcRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\bun.lock"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\tsconfig.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; The uninstaller reads this to name the shared root in what it says it left behind. It changes
; nothing under that path.
Root: HKLM; Subkey: "Software\sukarfleet"; ValueType: string; ValueName: "SharedRoot"; ValueData: "{code:GetSharedRoot}"; Flags: uninsdeletekey; Check: IsAdminInstallMode

[Run]
; Both scripts run through cmd.exe so that everything they print lands in a log file next to
; what they installed. A silent install has no window to read, and a wizard window closes with
; the wizard; the log is what remains when something went wrong.
Filename: "{cmd}"; Parameters: "{code:MachineNodeCmd}"; StatusMsg: "Installing the machine-wide node. This takes a few minutes."; Flags: waituntilterminated runhidden; Check: IsAdminInstallMode
Filename: "{cmd}"; Parameters: "{code:UserNodeCmd}"; StatusMsg: "Installing the node for this account. This takes a few minutes."; Flags: waituntilterminated runhidden; Check: not IsAdminInstallMode

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\install\windows\Uninstall-MachineNode.ps1"" -AppDir ""{app}"" -SharedRoot ""{reg:HKLM\Software\sukarfleet,SharedRoot|C:\AI_Agent}"""; RunOnceId: "RemoveMachineNode"; Flags: waituntilterminated runhidden; Check: IsAdminInstallMode
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\install\windows\Uninstall-UserNode.ps1"""; RunOnceId: "RemoveUserNode"; Flags: waituntilterminated runhidden; Check: not IsAdminInstallMode

[Code]

var
  PageIdentity: TInputQueryWizardPage;
  PageRole: TInputOptionWizardPage;
  PageSecret: TInputQueryWizardPage;
  PageShared: TInputQueryWizardPage;
  PageAdopt: TInputOptionWizardPage;
  PerUserTaskExists: Boolean;
  SecretFilePath: String;
  SecretIsOurs: Boolean;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function ParamValue(const Name, Default: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|' + Default + '}');
end;

// A bare switch such as /SKIPMESH never reaches {param:}: that constant only sees name=value
// pairs, and answered "absent" for every switch on the first real run. So the command line is
// walked by hand, accepting both /NAME and /NAME=anything, case-insensitively.
function HasSwitch(const Name: String): Boolean;
var
  I: Integer;
  P: String;
begin
  Result := False;
  for I := 1 to ParamCount do
  begin
    P := ParamStr(I);
    if (CompareText(P, '/' + Name) = 0) or
       (CompareText(Copy(P, 1, Length(Name) + 2), '/' + Name + '=') = 0) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

// What the wizard collected beats what the command line said, because a person who just typed
// an answer into a box should not have it silently overruled. In a silent install there is no
// box, so the command line is all there is.
function Pick(const ParamName, PageValue, Default: String): String;
begin
  if not WizardSilent then
  begin
    Result := Trim(PageValue);
    if Result <> '' then Exit;
  end;
  Result := Trim(ParamValue(ParamName, ''));
  if Result = '' then Result := Default;
end;

function SkipMeshWanted(): Boolean;
begin
  Result := HasSwitch('SKIPMESH');
end;

function SkipTrayWanted(): Boolean;
begin
  Result := HasSwitch('SKIPTRAY');
end;

function NoOpenWanted(): Boolean;
begin
  Result := HasSwitch('NOOPEN');
end;

// ---------------------------------------------------------------------------
// The machine as it is now
// ---------------------------------------------------------------------------

// A per-user node registers a scheduled task called sukarfleet. Its presence is the whole
// reason the adopt question exists, so the question is only asked when the answer matters.
function ScheduledTaskExists(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec('schtasks.exe', '/Query /TN sukarfleet', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 0);
end;

function AdoptWanted(): Boolean;
begin
  Result := (ParamValue('ADOPT', '0') = '1');
  if (not Result) and (not WizardSilent) and IsAdminInstallMode and PerUserTaskExists then
    Result := PageAdopt.Values[0];
end;

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

function GetDefaultDir(Param: String): String;
begin
  if IsAdminInstallMode then
    Result := ExpandConstant('{commonpf64}\sukarfleet\app')
  else
    Result := ExpandConstant('{localappdata}\sukarfleet\app');
end;

function GetMachineName(): String;
begin
  Result := Pick('MACHINE', PageIdentity.Values[0], ExpandConstant('{computername}'));
end;

function GetMeshIp(): String;
begin
  Result := Pick('MESHIP', PageIdentity.Values[1], '');
end;

function GetPeers(): String;
begin
  Result := Pick('PEER', PageIdentity.Values[2], '');
end;

function GetRole(): String;
begin
  if (not WizardSilent) and PageRole.Values[0] then
    Result := 'anchor'
  else if (not WizardSilent) and PageRole.Values[1] then
    Result := 'roamer'
  else
    Result := ParamValue('ROLE', 'roamer');
  if (Result <> 'anchor') and (Result <> 'roamer') then Result := 'roamer';
end;

function GetSharedRoot(Param: String): String;
begin
  Result := Pick('SHAREDROOT', PageShared.Values[0], 'C:\AI_Agent');
end;

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

procedure InitializeWizard();
begin
  PerUserTaskExists := ScheduledTaskExists();
  SecretFilePath := '';
  SecretIsOurs := False;

  PageIdentity := CreateInputQueryPage(wpSelectDir,
    'This machine',
    'How this machine appears in the fleet',
    'A machine with no mesh address can be installed, but it cannot be reached until you set one in the console.');
  PageIdentity.Add('Machine name:', False);
  PageIdentity.Add('Mesh address for this machine, e.g. 192.0.2.3:', False);
  PageIdentity.Add('A machine already in the fleet, e.g. tcp://198.51.100.7:11010 (comma separated for more than one):', False);
  PageIdentity.Values[0] := ParamValue('MACHINE', ExpandConstant('{computername}'));
  PageIdentity.Values[1] := ParamValue('MESHIP', '');
  PageIdentity.Values[2] := ParamValue('PEER', '');

  PageRole := CreateInputOptionPage(PageIdentity.ID,
    'Role',
    'Anchor or roamer',
    'An anchor keeps a stable address others dial. A roamer moves, and dials an anchor to find its way in. Pick roamer if you are unsure.',
    True, False);
  PageRole.Add('anchor');
  PageRole.Add('roamer');
  if ParamValue('ROLE', 'roamer') = 'anchor' then
    PageRole.Values[0] := True
  else
    PageRole.Values[1] := True;

  PageSecret := CreateInputQueryPage(PageRole.ID,
    'Mesh secret',
    'The one secret every machine in this fleet shares',
    'On a Linux fleet machine it is the network_secret line in /etc/easytier/fleet.toml, readable as root. It is not echoed, and it is written to a file only this account can read, which the elevated stage consumes and overwrites.');
  PageSecret.Add('Network secret:', True);

  PageShared := CreateInputQueryPage(PageSecret.ID,
    'Shared root',
    'Where the synced repositories live',
    'A machine-wide node runs as a service and cannot reach into anyone''s profile, so the repositories it syncs live in one directory every account on this machine can write in.');
  PageShared.Add('Shared root:', False);
  PageShared.Values[0] := ParamValue('SHAREDROOT', 'C:\AI_Agent');

  PageAdopt := CreateInputOptionPage(PageShared.ID,
    'An existing node',
    'This machine already runs sukarfleet for one account',
    'One identity per PC. Adopting moves that node''s identity, config, state and repositories into the machine-wide install, so the fleet keeps seeing one machine rather than two. Its repositories move into the shared root, with a junction left where they were, except any that sit inside a dot-directory of the profile: those stay where they are and are made reachable in place. Without this the install refuses.',
    False, False);
  PageAdopt.Add('Adopt the node that is installed for one account');
  PageAdopt.Values[0] := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = PageSecret.ID then
    Result := SkipMeshWanted() or (ParamValue('MESHSECRETFILE', '') <> '');
  if PageID = PageShared.ID then
    Result := not IsAdminInstallMode;
  if PageID = PageAdopt.ID then
    Result := (not IsAdminInstallMode) or (not PerUserTaskExists);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  // A silent install walks every page with nobody at the keyboard, and a MsgBox raised from
  // [Code] is not one of the boxes /SUPPRESSMSGBOXES answers: it waits forever. Seen on a
  // hosted runner and reproduced on a real machine. Silent runs take their answers from the
  // command line, and the scripts refuse for themselves when an answer is missing.
  if WizardSilent then Exit;
  if CurPageID = PageIdentity.ID then
  begin
    if Trim(PageIdentity.Values[0]) = '' then
    begin
      MsgBox('This machine needs a name. It is how the rest of the fleet refers to it.', mbError, MB_OK);
      Result := False;
    end
    else if IsAdminInstallMode and (not SkipMeshWanted()) and (Trim(PageIdentity.Values[1]) = '') then
    begin
      // The machine-wide install runs with nobody at the keyboard, so there is no prompt to
      // fall back to: an address it does not have here is an address it never gets.
      MsgBox('A machine-wide install needs this machine''s mesh address now. Pick one that is free on your fleet''s mesh subnet, or re-run with /SKIPMESH if the mesh transport is already installed here.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = PageSecret.ID then
  begin
    if Trim(PageSecret.Values[0]) = '' then
    begin
      MsgBox('Without the network secret this machine cannot join the mesh. Paste it, or go back and re-run with /SKIPMESH if the mesh transport is already installed here.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = PageShared.ID then
  begin
    if Trim(PageShared.Values[0]) = '' then
    begin
      MsgBox('The shared root needs a path. C:\AI_Agent is the default.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// ---------------------------------------------------------------------------
// The secret never travels as an argument
// ---------------------------------------------------------------------------

// argv is readable by every process on the machine and lands in a shell history, so the secret
// goes to a file with inheritance broken and one account on it, and the installer scripts
// consume and overwrite that file. A file the operator named with /MESHSECRETFILE is used as it
// is and never deleted: it is not ours.
procedure StageMeshSecret();
var
  Secret, Target, Dir, AclArgs: String;
  ResultCode: Integer;
begin
  SecretFilePath := Trim(ParamValue('MESHSECRETFILE', ''));
  if SecretFilePath <> '' then Exit;
  if SkipMeshWanted() then Exit;
  if WizardSilent then Exit;

  Secret := Trim(PageSecret.Values[0]);
  if Secret = '' then Exit;

  if IsAdminInstallMode then
  begin
    // Setup deletes {tmp} when it finishes; Install-MachineNode.ps1 overwrites this file the
    // moment it has copied the secret into the node's own state directory.
    Target := ExpandConstant('{tmp}\mesh-secret');
    AclArgs := '"' + Target + '" /inheritance:r /grant:r "*S-1-5-32-544:(F)" "*S-1-5-18:(F)"';
  end
  else
  begin
    // Exactly where Install-Sukarfleet.ps1 stages its own: its Test-StagedSecretPath recognises
    // this path as the installer's, which is what makes it shred the file rather than leave it.
    Dir := ExpandConstant('{%USERPROFILE}') + '\.local\state\sukarfleet';
    ForceDirectories(Dir);
    Target := Dir + '\pending-easytier-secret';
    AclArgs := '"' + Target + '" /inheritance:r /grant:r "' + ExpandConstant('{username}') +
      ':(F)" "*S-1-5-32-544:(F)" "*S-1-5-18:(F)"';
  end;

  if not SaveStringToFile(Target, Secret + #10, False) then
  begin
    RaiseException('Could not write the mesh secret to ' + Target + '. Nothing was installed.');
  end;
  if not Exec('icacls.exe', AclArgs, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;
  if ResultCode <> 0 then
    Log('icacls on the staged mesh secret returned ' + IntToStr(ResultCode) + '; the file keeps the inherited ACL of its directory.');

  SecretFilePath := Target;
  SecretIsOurs := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then StageMeshSecret();
end;

// ---------------------------------------------------------------------------
// What the two scopes are asked to run
// ---------------------------------------------------------------------------

function CommonNodeArgs(): String;
var
  s: String;
begin
  s := ' -MachineName "' + GetMachineName() + '"';
  s := s + ' -Role ' + GetRole();
  if GetMeshIp() <> '' then s := s + ' -MeshIp "' + GetMeshIp() + '"';
  if GetPeers() <> '' then s := s + ' -PeerUri "' + GetPeers() + '"';
  if SecretFilePath <> '' then s := s + ' -MeshSecretFile "' + SecretFilePath + '"';
  if SkipMeshWanted() then s := s + ' -SkipMesh';
  if SkipTrayWanted() then s := s + ' -SkipTray';
  if NoOpenWanted() then s := s + ' -NoOpen';
  Result := s;
end;

function UserNodeParams(): String;
var
  App: String;
begin
  App := ExpandConstant('{app}');
  Result := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + App + '\install\windows\Install-Sukarfleet.ps1"' +
    ' -Source "' + App + '"' + CommonNodeArgs();
end;

function MachineNodeParams(): String;
var
  App: String;
begin
  App := ExpandConstant('{app}');
  Result := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + App + '\install\windows\Install-MachineNode.ps1"' +
    ' -AppDir "' + App + '"' +
    ' -SharedRoot "' + GetSharedRoot('') + '"' + CommonNodeArgs();
  if AdoptWanted() then Result := Result + ' -Adopt';
  if SecretIsOurs then Result := Result + ' -ShredSecretSource';
end;

// cmd.exe /C "powershell.exe <args> > <log> 2>&1". The outer quotes are cmd's; -NonInteractive
// makes a prompt fail instead of wait, which is the only honest answer with no keyboard.
function UserNodeCmd(Param: String): String;
var
  LogPath: String;
begin
  LogPath := ExpandConstant('{localappdata}\sukarfleet\install-user.log');
  ForceDirectories(ExtractFileDir(LogPath));
  Result := '/C "powershell.exe ' + UserNodeParams() + ' > "' + LogPath + '" 2>&1"';
end;

function MachineNodeCmd(Param: String): String;
var
  LogPath: String;
begin
  LogPath := ExpandConstant('{commonappdata}\sukarfleet\install-machine.log');
  ForceDirectories(ExtractFileDir(LogPath));
  Result := '/C "powershell.exe ' + MachineNodeParams() + ' > "' + LogPath + '" 2>&1"';
end;
