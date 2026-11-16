// Throwaway bench tooling (issue #80): opens a bench URL in WebView2 (the machine's Evergreen
// runtime) and exits 0 once the page has posted its result to bench/device/serve.mjs
// (window.__benchPosted), 1 if WebView2 fails to start. Prints the runtime version and user agent.
// Usage: WebView2Host.exe <url>  (built and run by .github/workflows/webview2-bench.yml)
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: WebView2Host <url>");
            return 2;
        }
        Console.WriteLine($"WebView2 runtime {CoreWebView2Environment.GetAvailableBrowserVersionString()}");
        var form = new Form { Width = 1280, Height = 800, Text = "pglite-cipher bench" };
        var view = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(view);
        var code = 1;
        form.Load += async (_, _) =>
        {
            try
            {
                await view.EnsureCoreWebView2Async();
                Console.WriteLine($"user agent {view.CoreWebView2.Settings.UserAgent}");
                var timer = new System.Windows.Forms.Timer { Interval = 2000 };
                var polling = false;
                timer.Tick += async (_, _) =>
                {
                    if (polling) return;
                    polling = true;
                    if (await view.ExecuteScriptAsync("window.__benchPosted === true") == "true")
                    {
                        code = 0;
                        timer.Stop();
                        form.Close();
                    }
                    polling = false;
                };
                view.CoreWebView2.Navigate(args[0]);
                timer.Start();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"WebView2 failed: {e.Message}");
                form.Close();
            }
        };
        Application.Run(form);
        return code;
    }
}
