// Throwaway bench tooling (issue #80): opens a bench URL in WebView2 (the machine's Evergreen
// runtime) and exits 0 once the page has posted its result to bench/device/serve.mjs
// (window.__benchPosted), 1 if WebView2 fails to start, navigation fails, the browser or page render
// process exits or polling throws. Prints the runtime version and user agent.
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
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        var form = new Form { Width = 1280, Height = 800, Text = "pglite-cipher bench" };
        var view = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(view);
        var code = 1;
        void Fail(string what)
        {
            Console.Error.WriteLine($"WebView2 failed: {what}");
            code = 1;
            form.Close();
        }
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
                    try
                    {
                        if (await view.ExecuteScriptAsync("window.__benchPosted === true") == "true")
                        {
                            code = 0;
                            timer.Stop();
                            form.Close();
                        }
                    }
                    catch (Exception e)
                    {
                        timer.Stop();
                        Fail($"poll: {e.Message}");
                    }
                    polling = false;
                };
                view.CoreWebView2.ProcessFailed += (_, e) =>
                {
                    // Only these two take the bench page down. WebView2 restarts the GPU, utility and
                    // sandbox helper processes itself, an unresponsive renderer can recover, and a frame
                    // render process holds subframes only (the bench page has none): log and keep polling.
                    if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited
                        or CoreWebView2ProcessFailedKind.RenderProcessExited)
                    {
                        timer.Stop();
                        Fail($"process {e.ProcessFailedKind}");
                    }
                    else Console.Error.WriteLine($"WebView2 process {e.ProcessFailedKind}, continuing");
                };
                view.CoreWebView2.NavigationCompleted += (_, e) =>
                {
                    if (e.IsSuccess) return;
                    timer.Stop();
                    Fail($"navigation {e.WebErrorStatus}");
                };
                view.CoreWebView2.Navigate(args[0]);
                timer.Start();
            }
            catch (Exception e)
            {
                Fail(e.Message);
            }
        };
        Application.Run(form);
        return code;
    }
}
