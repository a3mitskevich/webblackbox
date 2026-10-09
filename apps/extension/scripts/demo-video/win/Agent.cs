// Desktop input agent for the demo-video recorder. Compiled by agent.ps1 (Add-Type) and driven
// by the Node orchestrator over stdin/stdout, one JSON command per line:
//   -> {"id":1,"cmd":"moveTo","x":100,"y":200}
//   <- {"id":1,"ok":true,"result":{...}}
// Every input burst first checks the shared abort event (set by Watchdog.cs when the owner presses
// Escape or throws the cursor into a screen corner) and the foreground window, so the agent never
// types into a window that is not the demo browser; mouse buttons and the wheel also check the
// window under the cursor, so a topmost window of another app over the target is never clicked.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Wbb
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }

        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
    }

    public class AbortedException : Exception
    {
        public AbortedException() : base("aborted by the owner") { }
    }

    public static class Agent
    {
        public const string AbortEventName = "Local\\wbb-demo-video-abort";
        private static EventWaitHandle abortEvent;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        private static readonly Random Rng = new Random(51);
        private static readonly HashSet<ushort> HeldKeys = new HashSet<ushort>();
        private static bool leftHeld;
        // The foreground guard: input is only sent while a window of one of these processes is in
        // front. Set by the orchestrator once the demo browser runs ("guard" command).
        private static HashSet<uint> guardPids = new HashSet<uint>();

        public static void Run()
        {
            // Per-monitor DPI awareness: UIA rectangles, cursor and window coordinates all in pixels.
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            Native.timeBeginPeriod(1);
            abortEvent = new EventWaitHandle(false, EventResetMode.ManualReset, AbortEventName);
            abortEvent.Reset();
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            stdout.WriteLine(Json.Serialize(new Dictionary<string, object> { { "ready", true } }));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                object id = null;
                var reply = new Dictionary<string, object>();
                try
                {
                    var req = (Dictionary<string, object>)Json.DeserializeObject(line);
                    id = req.ContainsKey("id") ? req["id"] : null;
                    reply["result"] = Dispatch(req);
                    reply["ok"] = true;
                }
                catch (AbortedException ex)
                {
                    ReleaseAll();
                    reply["ok"] = false;
                    reply["aborted"] = true;
                    reply["error"] = ex.Message;
                }
                catch (Exception ex)
                {
                    ReleaseAll();
                    reply["ok"] = false;
                    reply["error"] = ex.GetType().Name + ": " + ex.Message;
                }
                reply["id"] = id;
                stdout.WriteLine(Json.Serialize(reply));
            }
            ReleaseAll();
        }

        private static object Dispatch(Dictionary<string, object> req)
        {
            string cmd = Str(req, "cmd");
            if (cmd != "ping" && cmd != "resetAbort" && cmd != "release") CheckAbort();
            switch (cmd)
            {
                case "ping": return "pong";
                case "resetAbort": abortEvent.Reset(); return null;
                case "release": ReleaseAll(); return null;
                case "guard": return SetGuard(req);
                case "cursor": { Native.POINT p; Native.GetCursorPos(out p); return Pt(p.X, p.Y); }
                case "screen": return new Dictionary<string, object> { { "width", Native.GetSystemMetrics(0) }, { "height", Native.GetSystemMetrics(1) } };
                case "windows": return ListWindows(req);
                case "windowRect": return WindowRect(HwndOf(req));
                case "placeWindow": return PlaceWindow(req);
                // Cleanup only: closes a window the recorder opened itself (e.g. Explorer).
                case "closeWindow": return Native.PostMessage(HwndOf(req), 0x0010, IntPtr.Zero, IntPtr.Zero);
                case "foreground": return Foreground(req);
                case "foregroundInfo": return WindowInfo(Native.GetForegroundWindow());
                case "uiaFind": return UiaFind(req);
                case "uiaInvoke": return UiaInvoke(req);
                case "uiaTree": return UiaTree(req);
                case "moveTo": MoveTo(Int(req, "x"), Int(req, "y"), Int(req, "durationMs", -1)); return null;
                case "click": return Click(req);
                case "mouseDown": GuardForeground(); GuardPointTarget(); MouseButton(Str(req, "button", "left"), true); return null;
                case "mouseUp": MouseButton(Str(req, "button", "left"), false); return null;
                case "wheel": return Wheel(req);
                case "type": TypeText(Str(req, "text"), Int(req, "charDelayMs", 70)); return null;
                case "keys": PressCombo(Str(req, "combo")); return null;
                default: throw new ArgumentException("unknown command " + cmd);
            }
        }

        // ---- helpers: json --------------------------------------------------------------------

        private static string Str(Dictionary<string, object> d, string key, string fallback = null)
        {
            object v;
            if (d.TryGetValue(key, out v) && v != null) return Convert.ToString(v);
            if (fallback != null) return fallback;
            throw new ArgumentException("missing " + key);
        }

        private static int Int(Dictionary<string, object> d, string key, int? fallback = null)
        {
            object v;
            if (d.TryGetValue(key, out v) && v != null) return (int)Math.Round(Convert.ToDouble(v));
            if (fallback.HasValue) return fallback.Value;
            throw new ArgumentException("missing " + key);
        }

        private static bool Bool(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        private static Dictionary<string, object> Pt(int x, int y)
        {
            return new Dictionary<string, object> { { "x", x }, { "y", y } };
        }

        private static Dictionary<string, object> Rect(int l, int t, int r, int b)
        {
            return new Dictionary<string, object> { { "left", l }, { "top", t }, { "right", r }, { "bottom", b }, { "width", r - l }, { "height", b - t } };
        }

        private static IntPtr HwndOf(Dictionary<string, object> req)
        {
            return new IntPtr(Convert.ToInt64(req["hwnd"]));
        }

        // ---- abort and foreground guard ------------------------------------------------------

        private static void CheckAbort()
        {
            if (abortEvent.WaitOne(0)) throw new AbortedException();
        }

        private static object SetGuard(Dictionary<string, object> req)
        {
            var next = new HashSet<uint>();
            foreach (var p in (IEnumerable)req["pids"]) next.Add(Convert.ToUInt32(p));
            guardPids = next;
            return guardPids.Count;
        }

        private static void GuardForeground()
        {
            if (guardPids.Count == 0) return;
            uint pid;
            Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
            if (!guardPids.Contains(pid))
                throw new InvalidOperationException("foreground window is not a demo window (pid " + pid + "); input refused");
        }

        // A click lands on whatever window is under the cursor, not on the foreground one: a topmost
        // window of another app (a notification, an always-on-top tool) can cover the target.
        private static void GuardPointTarget()
        {
            if (guardPids.Count == 0) return;
            Native.POINT p;
            Native.GetCursorPos(out p);
            IntPtr root = Native.GetAncestor(Native.WindowFromPoint(p), 2); // GA_ROOT
            uint pid;
            Native.GetWindowThreadProcessId(root, out pid);
            if (!guardPids.Contains(pid))
                throw new InvalidOperationException("the window under the cursor is not a demo window (pid " + pid + " at " + p.X + "," + p.Y + "); input refused");
        }

        private static void ReleaseAll()
        {
            if (leftHeld) MouseButton("left", false);
            foreach (var vk in new List<ushort>(HeldKeys)) Key(vk, false);
        }

        // ---- windows --------------------------------------------------------------------------

        private static Dictionary<string, object> WindowInfo(IntPtr h)
        {
            var title = new StringBuilder(512);
            var cls = new StringBuilder(256);
            Native.GetWindowText(h, title, title.Capacity);
            Native.GetClassName(h, cls, cls.Capacity);
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            var info = new Dictionary<string, object>
            {
                { "hwnd", h.ToInt64() }, { "title", title.ToString() }, { "className", cls.ToString() }, { "pid", (long)pid },
                { "visible", Native.IsWindowVisible(h) }, { "owner", Native.GetWindow(h, 4).ToInt64() }
            };
            info["rect"] = WindowRect(h);
            return info;
        }

        private static object ListWindows(Dictionary<string, object> req)
        {
            var pids = new HashSet<uint>();
            if (req.ContainsKey("pids")) foreach (var p in (IEnumerable)req["pids"]) pids.Add(Convert.ToUInt32(p));
            var list = new List<object>();
            Native.EnumWindows((h, l) =>
            {
                if (!Native.IsWindowVisible(h)) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (pids.Count > 0 && !pids.Contains(pid)) return true;
                list.Add(WindowInfo(h));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        // The visible frame (DWM extended frame bounds), without the invisible resize borders.
        private static Dictionary<string, object> WindowRect(IntPtr h)
        {
            Native.RECT r;
            if (Native.DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0)
                Native.GetWindowRect(h, out r);
            return Rect(r.Left, r.Top, r.Right, r.Bottom);
        }

        // Places a window so that its VISIBLE frame is exactly x,y,w,h.
        private static object PlaceWindow(Dictionary<string, object> req)
        {
            IntPtr h = HwndOf(req);
            int x = Int(req, "x"), y = Int(req, "y"), w = Int(req, "width"), hh = Int(req, "height");
            Native.ShowWindow(h, 9); // SW_RESTORE
            Native.SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0014); // NOZORDER | NOACTIVATE
            Thread.Sleep(80);
            Native.RECT outer;
            Native.GetWindowRect(h, out outer);
            var vis = WindowRect(h);
            int dl = (int)vis["left"] - outer.Left, dt = (int)vis["top"] - outer.Top;
            int dr = outer.Right - (int)vis["right"], db = outer.Bottom - (int)vis["bottom"];
            Native.SetWindowPos(h, IntPtr.Zero, x - dl, y - dt, w + dl + dr, hh + dt + db, 0x0014);
            Thread.Sleep(80);
            return WindowRect(h);
        }

        private static object Foreground(Dictionary<string, object> req)
        {
            IntPtr h = HwndOf(req);
            if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
            // SetForegroundWindow is refused unless the caller "owns" the last input; a synthetic ALT
            // tap satisfies the foreground lock rule without side effects in Chrome.
            Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
            Native.keybd_event(0x12, 0, 2, UIntPtr.Zero);
            bool ok = Native.SetForegroundWindow(h);
            Thread.Sleep(120);
            return ok && Native.GetForegroundWindow() == h;
        }

        // ---- UI Automation --------------------------------------------------------------------

        private static ControlType ControlTypeByName(string name)
        {
            switch (name)
            {
                case "Button": return ControlType.Button;
                case "CheckBox": return ControlType.CheckBox;
                case "Edit": return ControlType.Edit;
                case "MenuItem": return ControlType.MenuItem;
                case "Menu": return ControlType.Menu;
                case "ListItem": return ControlType.ListItem;
                case "Document": return ControlType.Document;
                case "Pane": return ControlType.Pane;
                case "Window": return ControlType.Window;
                case "Hyperlink": return ControlType.Hyperlink;
                case "Text": return ControlType.Text;
                case "TreeItem": return ControlType.TreeItem;
                case "ComboBox": return ControlType.ComboBox;
                case "SplitButton": return ControlType.SplitButton;
                case "TabItem": return ControlType.TabItem;
                case "ToolBar": return ControlType.ToolBar;
                case "Group": return ControlType.Group;
                default: throw new ArgumentException("unsupported control type " + name);
            }
        }

        private static bool NameMatches(string actual, Dictionary<string, object> req)
        {
            if (!req.ContainsKey("name") || req["name"] == null) return true;
            string want = Str(req, "name");
            string mode = Str(req, "match", "exact");
            if (actual == null) return false;
            switch (mode)
            {
                case "exact": return actual == want;
                case "contains": return actual.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
                case "startsWith": return actual.StartsWith(want, StringComparison.OrdinalIgnoreCase);
                case "regex": return Regex.IsMatch(actual, want);
                default: throw new ArgumentException("unknown match mode " + mode);
            }
        }

        private static List<AutomationElement> UiaSearch(Dictionary<string, object> req)
        {
            var root = AutomationElement.FromHandle(HwndOf(req));
            Condition cond = Condition.TrueCondition;
            if (req.ContainsKey("controlType") && req["controlType"] != null)
                cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlTypeByName(Str(req, "controlType")));
            if (Str(req, "match", "exact") == "exact" && req.ContainsKey("name") && req["name"] != null)
                cond = new AndCondition(cond, new PropertyCondition(AutomationElement.NameProperty, Str(req, "name")));
            var found = new List<AutomationElement>();
            foreach (AutomationElement el in root.FindAll(TreeScope.Descendants, cond))
            {
                string name;
                try { name = el.Current.Name; } catch (ElementNotAvailableException) { continue; }
                if (!NameMatches(name, req)) continue;
                if (Bool(req, "visibleOnly"))
                {
                    try { if (el.Current.IsOffscreen || el.Current.BoundingRectangle.IsEmpty) continue; }
                    catch (ElementNotAvailableException) { continue; }
                }
                found.Add(el);
            }
            return found;
        }

        private static Dictionary<string, object> Describe(AutomationElement el)
        {
            var c = el.Current;
            var r = c.BoundingRectangle;
            var d = new Dictionary<string, object>
            {
                { "name", c.Name }, { "controlType", c.ControlType.ProgrammaticName.Replace("ControlType.", "") },
                { "automationId", c.AutomationId }, { "className", c.ClassName }, { "enabled", c.IsEnabled },
                { "offscreen", c.IsOffscreen }
            };
            if (!r.IsEmpty)
            {
                d["rect"] = Rect((int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom);
                d["center"] = Pt((int)(r.Left + r.Width / 2), (int)(r.Top + r.Height / 2));
            }
            object pattern;
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                d["toggle"] = ((TogglePattern)pattern).Current.ToggleState.ToString();
            return d;
        }

        // Waits (polling) for the element; returns its description or throws on timeout.
        private static object UiaFind(Dictionary<string, object> req)
        {
            int timeout = Int(req, "timeoutMs", 5000);
            int index = Int(req, "index", 0);
            bool all = Bool(req, "all");
            var sw = Stopwatch.StartNew();
            while (true)
            {
                CheckAbort();
                List<AutomationElement> found;
                try { found = UiaSearch(req); }
                catch (ElementNotAvailableException) { found = new List<AutomationElement>(); }
                if (all)
                {
                    var list = new List<object>();
                    foreach (var el in found) { try { list.Add(Describe(el)); } catch (ElementNotAvailableException) { } }
                    if (list.Count > 0 || sw.ElapsedMilliseconds >= timeout) return list;
                }
                else if (found.Count > index)
                {
                    try { return Describe(found[index]); } catch (ElementNotAvailableException) { }
                }
                if (sw.ElapsedMilliseconds >= timeout)
                {
                    if (Bool(req, "optional")) return null;
                    throw new TimeoutException("UIA element not found: " + Str(req, "controlType", "*") + " '" + Str(req, "name", "*") + "'");
                }
                Thread.Sleep(150);
            }
        }

        // Invokes/toggles an element through UIA patterns (used only off camera, e.g. to dismiss a
        // stray bubble before a take).
        private static object UiaInvoke(Dictionary<string, object> req)
        {
            var found = UiaSearch(req);
            if (found.Count == 0) throw new InvalidOperationException("nothing to invoke");
            object pattern;
            if (found[0].TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return "invoke"; }
            if (found[0].TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return "toggle"; }
            throw new InvalidOperationException("element supports neither Invoke nor Toggle");
        }

        // Debug helper: a flat dump of named descendants (used while writing scenarios).
        private static object UiaTree(Dictionary<string, object> req)
        {
            var root = AutomationElement.FromHandle(HwndOf(req));
            int max = Int(req, "max", 400);
            var list = new List<object>();
            foreach (AutomationElement el in root.FindAll(TreeScope.Descendants, Condition.TrueCondition))
            {
                if (list.Count >= max) break;
                try
                {
                    if (string.IsNullOrEmpty(el.Current.Name) && !Bool(req, "includeUnnamed")) continue;
                    list.Add(Describe(el));
                }
                catch (ElementNotAvailableException) { }
            }
            return list;
        }

        // ---- mouse ----------------------------------------------------------------------------

        private static void SendMouse(uint flags, int dx = 0, int dy = 0, uint data = 0)
        {
            var input = new Native.INPUT { type = Native.INPUT_MOUSE };
            input.u.mi = new Native.MOUSEINPUT { dx = dx, dy = dy, dwFlags = flags, mouseData = data };
            Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
        }

        private static void SetCursor(double x, double y)
        {
            int w = Native.GetSystemMetrics(0), h = Native.GetSystemMetrics(1);
            int ax = (int)Math.Round(x * 65535.0 / (w - 1));
            int ay = (int)Math.Round(y * 65535.0 / (h - 1));
            SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE, ax, ay);
        }

        // Human-speed motion: ease-in-out along a gentle arc, duration grows with distance.
        public static void MoveTo(int x, int y, int durationMs)
        {
            Native.POINT p;
            Native.GetCursorPos(out p);
            double dx = x - p.X, dy = y - p.Y;
            double dist = Math.Sqrt(dx * dx + dy * dy);
            if (dist < 1) return;
            int ms = durationMs >= 0 ? durationMs : (int)Math.Min(1100, Math.Max(280, 220 + dist * 0.55));
            double bow = Math.Min(dist * 0.08, 36) * (Rng.Next(2) == 0 ? 1 : -1);
            double nx = -dy / dist, ny = dx / dist;
            var sw = Stopwatch.StartNew();
            while (true)
            {
                CheckAbort();
                double t = Math.Min(1.0, sw.ElapsedMilliseconds / (double)Math.Max(ms, 1));
                double e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
                double arc = Math.Sin(Math.PI * e) * bow;
                SetCursor(p.X + dx * e + nx * arc, p.Y + dy * e + ny * arc);
                if (t >= 1.0) break;
                Thread.Sleep(8);
            }
            SetCursor(x, y);
        }

        private static void MouseButton(string button, bool down)
        {
            uint flag = button == "right"
                ? (down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP)
                : (down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP);
            SendMouse(flag);
            if (button != "right") leftHeld = down;
        }

        private static object Click(Dictionary<string, object> req)
        {
            if (req.ContainsKey("x")) MoveTo(Int(req, "x"), Int(req, "y"), Int(req, "durationMs", -1));
            Thread.Sleep(Int(req, "settleMs", 140));
            CheckAbort();
            if (!Bool(req, "unguarded")) { GuardForeground(); GuardPointTarget(); }
            string button = Str(req, "button", "left");
            int count = Int(req, "count", 1);
            for (int i = 0; i < count; i++)
            {
                MouseButton(button, true);
                Thread.Sleep(60);
                MouseButton(button, false);
                if (i + 1 < count) Thread.Sleep(90);
            }
            return null;
        }

        private static object Wheel(Dictionary<string, object> req)
        {
            GuardForeground();
            GuardPointTarget();
            int notches = Int(req, "notches");
            int step = notches > 0 ? 1 : -1;
            for (int i = 0; i != notches; i += step)
            {
                CheckAbort();
                SendMouse(Native.MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(-120 * step)));
                Thread.Sleep(Int(req, "delayMs", 60));
            }
            return null;
        }

        // ---- keyboard -------------------------------------------------------------------------

        private static readonly ushort[] ExtendedKeys = { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E };

        private static void Key(ushort vk, bool down)
        {
            var input = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            uint flags = down ? 0u : Native.KEYEVENTF_KEYUP;
            if (Array.IndexOf(ExtendedKeys, vk) >= 0) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            input.u.ki = new Native.KEYBDINPUT { wVk = vk, dwFlags = flags };
            Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
            if (down) HeldKeys.Add(vk); else HeldKeys.Remove(vk);
        }

        private static void UnicodeChar(char ch)
        {
            var down = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            down.u.ki = new Native.KEYBDINPUT { wScan = ch, dwFlags = Native.KEYEVENTF_UNICODE };
            var up = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            up.u.ki = new Native.KEYBDINPUT { wScan = ch, dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP };
            Native.SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(Native.INPUT)));
        }

        private static void TypeText(string text, int charDelayMs)
        {
            foreach (char ch in text)
            {
                CheckAbort();
                GuardForeground();
                if (ch == '\n') { Key(0x0D, true); Key(0x0D, false); }
                else UnicodeChar(ch);
                Thread.Sleep(Math.Max(0, charDelayMs + Rng.Next(-charDelayMs / 3, charDelayMs / 3 + 1)));
            }
        }

        private static ushort VkByName(string name)
        {
            switch (name.ToLowerInvariant())
            {
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": return 0x12;
                case "win": return 0x5B;
                case "enter": return 0x0D;
                case "tab": return 0x09;
                case "space": return 0x20;
                case "backspace": return 0x08;
                case "delete": return 0x2E;
                case "esc": case "escape":
                    // Escape is the owner's abort key; the agent never sends it.
                    throw new ArgumentException("the agent never sends Escape (it is the abort key)");
                case "up": return 0x26;
                case "down": return 0x28;
                case "left": return 0x25;
                case "right": return 0x27;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "f5": return 0x74;
                case "f6": return 0x75;
                case "f12": return 0x7B;
            }
            if (name.Length == 1)
            {
                char c = char.ToUpperInvariant(name[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
                if (c == '/') return 0xBF;
                if (c == ',') return 0xBC;
                if (c == '.') return 0xBE;
            }
            throw new ArgumentException("unknown key " + name);
        }

        // "ctrl+shift+m", "enter", "ctrl+a"
        private static void PressCombo(string combo)
        {
            GuardForeground();
            var parts = combo.Split('+');
            var vks = new List<ushort>();
            foreach (var p in parts) vks.Add(VkByName(p.Trim()));
            foreach (var vk in vks) { Key(vk, true); Thread.Sleep(35); }
            Thread.Sleep(50);
            for (int i = vks.Count - 1; i >= 0; i--) { Key(vks[i], false); Thread.Sleep(25); }
        }
    }
}
