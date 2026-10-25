$ErrorActionPreference = 'Stop'
# Enumerate the actual visible windows of this test's SFX process tree. The
# Chromium main window is not necessarily Process.MainWindowHandle.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WsmbWindow {
  public int Pid;
  public long Handle;
  public string Title;
}
public static class WsmbWindows {
  private delegate bool Callback(IntPtr handle, IntPtr value);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr value);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static List<WsmbWindow> Find(int[] processIds) {
    var ids = new HashSet<int>(processIds);
    var result = new List<WsmbWindow>();
    EnumWindows((handle, value) => {
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      if (ids.Contains((int)pid) && IsWindowVisible(handle)) {
        var title = new StringBuilder(4096);
        GetWindowText(handle, title, title.Capacity);
        result.Add(new WsmbWindow { Pid=(int)pid, Handle=handle.ToInt64(), Title=title.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static void Close(long handle) {
    if (!PostMessage(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Could not close SFX Viewer window");
  }
}
'@
$all = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add([int]$env:WSMB_QA_SFX_PID)
do {
  $changed = $false
  foreach ($process in $all) {
    if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $changed = $true }
  }
} while ($changed)
$windows = @([WsmbWindows]::Find([int[]]@($ids)))
$windows | Select-Object Pid,Handle,Title | ConvertTo-Json -Compress
$matching = @($windows | Where-Object { $_.Title -ceq $env:WSMB_QA_TITLE })
if ($matching.Count -gt 0) {
  'READY'
  if ($env:WSMB_QA_CLOSE -eq '1') {
    foreach ($window in $matching) { [WsmbWindows]::Close($window.Handle) }
  }
}
exit 0
