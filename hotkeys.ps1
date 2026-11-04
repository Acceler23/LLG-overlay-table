# Hotkeys globais — funciona com o jogo em foco
# , . = coluna | [ ] = pagina | P = destaque | 0 = standings | 8 = g-force | 9 = disputas
# Se o AMS2 estiver como Admin, rode este script tambem como Admin.

# -ParentPid: PID do aplicativo que iniciou este script; se ele fechar, o
# script encerra sozinho.
param([int]$Port = 8080, [int]$ParentPid = 0)

$ErrorActionPreference = "Continue"
$cmdUrl = "http://127.0.0.1:$Port/command"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class KbHook {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_SYSKEYDOWN = 0x0104;

  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  public static ConcurrentQueue<int> Queue = new ConcurrentQueue<int>();

  private static IntPtr _hook = IntPtr.Zero;
  private static HookProc _proc = HookCallback;
  private static int _lastVk = -1;
  private static int _lastTick = 0;

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int id, HookProc lpfn, IntPtr hMod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);

  // Caractere que a tecla produz no layout de teclado da janela em foco.
  // O codigo da tecla (VK) depende do layout: num teclado ABNT2 o VK que nos
  // teclados americanos e "[" fica na tecla do acento agudo, e o "]" tem outro
  // VK. Por isso os atalhos sao reconhecidos pelo caractere, nao pelo VK.
  static char KeyChar(uint vk) {
    IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero));
    uint ch = MapVirtualKeyEx(vk, 2 /* MAPVK_VK_TO_CHAR */, layout);
    if ((ch & 0x80000000) != 0) return (char)0; // tecla morta (acento): nao e atalho
    return (char)(ch & 0xFFFF);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT {
    public uint vkCode;
    public uint scanCode;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  public static void Start() {
    using (Process cur = Process.GetCurrentProcess())
    using (ProcessModule mod = cur.MainModule) {
      _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
    }
    if (_hook == IntPtr.Zero)
      throw new Exception("Falha ao instalar hook (erro " + Marshal.GetLastWin32Error() + "). Rode como Administrador.");
  }

  public static void Stop() {
    if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
    _hook = IntPtr.Zero;
  }

  static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
      KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      int vk = (int)info.vkCode;
      int now = Environment.TickCount;
      if (vk != _lastVk || (now - _lastTick) > 200) {
        _lastVk = vk;
        _lastTick = now;
        // enfileira o caractere: , . [ ] P 0 9 (o 0 e o 9 do teclado numerico tambem valem)
        char c = vk == 0x60 ? '0' : vk == 0x68 ? '8' : vk == 0x69 ? '9' : KeyChar((uint)vk);
        if (c == ',' || c == '.' || c == '[' || c == ']' || c == 'P' || c == '0' || c == '8' || c == '9')
          Queue.Enqueue((int)c);
      }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }
}

public class PumpForm : Form {
  public Timer Timer;
  public PumpForm() {
    ShowInTaskbar = false;
    WindowState = FormWindowState.Minimized;
    Opacity = 0;
    FormBorderStyle = FormBorderStyle.FixedToolWindow;
    Timer = new Timer();
    Timer.Interval = 50;
  }
  protected override void SetVisibleCore(bool value) {
    base.SetVisibleCore(false);
  }
}
"@ -ReferencedAssemblies System.Windows.Forms

function Send-Cmd([string]$name) {
  try {
    $body = "{`"name`":`"$name`"}"
    $req = [System.Net.HttpWebRequest]::Create($cmdUrl)
    $req.Method = "POST"
    $req.ContentType = "application/json"
    $req.Timeout = 1500
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream()
    $s.Write($bytes, 0, $bytes.Length)
    $s.Close()
    $r = $req.GetResponse()
    $r.Close()
    return $true
  } catch {
    Write-Host ("Falha " + $name + ": " + $_.Exception.Message)
    return $false
  }
}

try {
  [KbHook]::Start()
  Write-Host "Hook OK. Teclas: , . [ ] P 0 8 9"
  Write-Host "Se o jogo for Admin, rode este script como Admin."
  Write-Host "Feche a janela para sair."

  $form = New-Object PumpForm
  $script:parentCheck = 0
  $form.Timer.add_Tick({
    # a cada ~2 s confere se o aplicativo que nos iniciou continua aberto
    $script:parentCheck++
    if ($ParentPid -gt 0 -and $script:parentCheck -ge 40) {
      $script:parentCheck = 0
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.Application]::Exit()
        return
      }
    }
    $vk = 0
    while ([KbHook]::Queue.TryDequeue([ref]$vk)) {
      switch ($vk) {
        44 { if (Send-Cmd "overlay.prevColumn") { Write-Host "[,] coluna -" } }
        46 { if (Send-Cmd "overlay.nextColumn") { Write-Host "[.] coluna +" } }
        91 { if (Send-Cmd "overlay.prevPage") { Write-Host "[[] pagina -" } }
        93 { if (Send-Cmd "overlay.nextPage") { Write-Host "[]] pagina +" } }
        80 { if (Send-Cmd "overlay.toggleHighlight") { Write-Host "[P] destaque" } }
        48 { if (Send-Cmd "overlay.toggleStandings") { Write-Host "[0] standings" } }
        56 { if (Send-Cmd "overlay.toggleGForce") { Write-Host "[8] g-force" } }
        57 { if (Send-Cmd "overlay.toggleBattles") { Write-Host "[9] disputas" } }
      }
    }
  })
  $form.Timer.Start()
  [System.Windows.Forms.Application]::Run($form)
} finally {
  [KbHook]::Stop()
}
