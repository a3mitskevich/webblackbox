// Abort watchdog for the demo-video recorder. Low-level keyboard and mouse hooks watch the owner's
// PHYSICAL input only (injected events from Agent.cs carry the INJECTED flag and are ignored):
//   - Escape pressed                      -> abort
//   - cursor pushed into a screen corner -> abort
// On abort it sets the shared event (Agent.cs stops mid-motion) and prints "ABORT <reason>" so the
// orchestrator stops ffmpeg and exits. It exits by itself when stdin closes (orchestrator gone).
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Wbb
{
    public static class Watchdog
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);

        private const int WH_KEYBOARD_LL = 13;
        private const int WH_MOUSE_LL = 14;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_MOUSEMOVE = 0x0200;
        private const uint LLKHF_INJECTED = 0x10;
        private const uint LLMHF_INJECTED = 0x01;
        private const int VK_ESCAPE = 0x1B;
        private const int CORNER_PX = 3;

        // Kept in static fields so the GC never collects the delegates while the hooks are live.
        private static HookProc keyboardProc;
        private static HookProc mouseProc;
        private static EventWaitHandle abortEvent;
        private static int aborted;
        private static StreamWriter stdout;

        public static void Run()
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            abortEvent = new EventWaitHandle(false, EventResetMode.ManualReset, Agent.AbortEventName);
            stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            keyboardProc = OnKeyboard;
            mouseProc = OnMouse;
            IntPtr module = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
            SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
            SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
            var stdinWatcher = new Thread(() =>
            {
                var stdin = Console.OpenStandardInput();
                var buf = new byte[64];
                while (stdin.Read(buf, 0, buf.Length) > 0) { }
                Environment.Exit(0);
            }) { IsBackground = true };
            stdinWatcher.Start();
            stdout.WriteLine("READY");
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        }

        private static void Abort(string reason)
        {
            if (Interlocked.Exchange(ref aborted, 1) == 1) return;
            abortEvent.Set();
            stdout.WriteLine("ABORT " + reason);
        }

        private static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (wParam.ToInt32() == WM_KEYDOWN || wParam.ToInt32() == WM_SYSKEYDOWN))
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (k.vkCode == VK_ESCAPE && (k.flags & LLKHF_INJECTED) == 0) Abort("escape");
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && wParam.ToInt32() == WM_MOUSEMOVE)
            {
                var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if ((m.flags & LLMHF_INJECTED) == 0)
                {
                    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
                    bool edgeX = m.x <= CORNER_PX || m.x >= w - 1 - CORNER_PX;
                    bool edgeY = m.y <= CORNER_PX || m.y >= h - 1 - CORNER_PX;
                    if (edgeX && edgeY) Abort("corner");
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }
    }
}
