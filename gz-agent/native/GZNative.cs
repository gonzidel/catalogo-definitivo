// gz-agent/native/GZNative.cs
// Helper nativo único para todo lo que necesita GZ del spooler de Windows:
// listar impresoras (antes: PowerShell + WMI, lento y abría ventana) e
// imprimir RAW (antes: PowerShell + Add-Type, recompilaba C# en cada click).
// Se compila UNA vez (scripts/build-native.js) a GZNative.exe.
//
//   GZNative.exe list                    -> {"printers":[...],"default":"..."}
//   GZNative.exe print <impresora> <archivo>
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing.Printing;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void SendBytesToPrinter(string printerName, byte[] data)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "GZ Print Job";
        di.pDataType = "RAW";
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter fallo para '" + printerName + "'");
        try
        {
            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("StartDocPrinter fallo");
            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter fallo");
                try
                {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(data.Length);
                    Marshal.Copy(data, 0, pUnmanagedBytes, data.Length);
                    int written;
                    bool ok = WritePrinter(hPrinter, pUnmanagedBytes, data.Length, out written);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    if (!ok) throw new Exception("WritePrinter fallo");
                }
                finally
                {
                    EndPagePrinter(hPrinter);
                }
            }
            finally
            {
                EndDocPrinter(hPrinter);
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}

public class Program
{
    static string JsonEscape(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static int RunList()
    {
        var sb = new StringBuilder();
        sb.Append("{\"printers\":[");
        bool first = true;
        foreach (string name in PrinterSettings.InstalledPrinters)
        {
            if (!first) sb.Append(",");
            sb.Append("\"").Append(JsonEscape(name)).Append("\"");
            first = false;
        }
        sb.Append("],\"default\":");

        string def = null;
        try
        {
            var ps = new PrinterSettings();
            if (ps.IsValid) def = ps.PrinterName;
        }
        catch { }

        if (string.IsNullOrEmpty(def)) sb.Append("null");
        else sb.Append("\"").Append(JsonEscape(def)).Append("\"");
        sb.Append("}");

        Console.WriteLine(sb.ToString());
        return 0;
    }

    static int RunPrint(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Uso: GZNative.exe print <impresora> <archivo>");
            return 2;
        }
        try
        {
            byte[] data = File.ReadAllBytes(args[1]);
            RawPrinterHelper.SendBytesToPrinter(args[0], data);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Uso: GZNative.exe list | GZNative.exe print <impresora> <archivo>");
            return 2;
        }

        string cmd = args[0];
        string[] rest = new string[args.Length - 1];
        Array.Copy(args, 1, rest, 0, rest.Length);

        if (cmd == "list") return RunList();
        if (cmd == "print") return RunPrint(rest);

        Console.Error.WriteLine("Comando desconocido: " + cmd);
        return 2;
    }
}
