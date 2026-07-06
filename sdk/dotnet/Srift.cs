// SRIFT .NET SDK — zero-dep client. .NET 6+ / .NET Standard 2.1+ / .NET Framework 4.7.2 with HttpClient.
// Works on: Windows, macOS, Linux, MAUI, Blazor (server + WASM), Unity, Godot (C#), Xamarin.
//
//   var s = new Srift.Client();
//   var r = await s.QuickShareAsync("/abs/path/file.zip");
//   Console.WriteLine(r["shareUrl"]);

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

namespace Srift
{
    public class SriftException : Exception { public SriftException(string m) : base(m) { } }

    public class Client : IDisposable
    {
        public readonly string BaseUrl;
        private readonly HttpClient _http;

        public Client(string? baseUrl = null, HttpClient? http = null)
        {
            BaseUrl = (baseUrl
                ?? Environment.GetEnvironmentVariable("SRIFT_BASE_URL")
                ?? "http://127.0.0.1:3822").TrimEnd('/');
            _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        }

        private async Task<string> CallRawAsync(string path, HttpMethod method, object? body = null)
        {
            using var req = new HttpRequestMessage(method, BaseUrl + path);
            if (body != null) req.Content = JsonContent.Create(body);
            try
            {
                using var resp = await _http.SendAsync(req).ConfigureAwait(false);
                var raw = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    try
                    {
                        var doc = JsonDocument.Parse(raw);
                        var msg = doc.RootElement.TryGetProperty("error", out var ep) ? ep.GetString() : null;
                        throw new SriftException(msg ?? $"HTTP {(int)resp.StatusCode}");
                    }
                    catch (SriftException) { throw; }
                    catch { throw new SriftException($"HTTP {(int)resp.StatusCode}: {raw}"); }
                }
                return raw;
            }
            catch (SriftException) { throw; }
            catch (HttpRequestException e)
            {
                throw new SriftException($"Daemon unreachable at {BaseUrl}. Start it with: srift daemon start. Cause: {e.Message}");
            }
        }

        private async Task<Dictionary<string, JsonElement>> CallAsync(string path, HttpMethod method, object? body = null)
        {
            var raw = await CallRawAsync(path, method, body).ConfigureAwait(false);
            return string.IsNullOrEmpty(raw) ? new() : JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(raw) ?? new();
        }

        private async Task<List<Dictionary<string, JsonElement>>> CallArrayAsync(string path, HttpMethod method, object? body = null)
        {
            var raw = await CallRawAsync(path, method, body).ConfigureAwait(false);
            return string.IsNullOrEmpty(raw) ? new() : JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(raw) ?? new();
        }

        public Task<Dictionary<string, JsonElement>> StatusAsync() => CallAsync("/status", HttpMethod.Get);
        public Task<Dictionary<string, JsonElement>> StateAsync() => CallAsync("/state", HttpMethod.Get);
        public Task<Dictionary<string, JsonElement>> QuickShareAsync(string filePath, string? sessionName = null) =>
            CallAsync("/quick-share", HttpMethod.Post, new { filePath, sessionName });
        public Task<Dictionary<string, JsonElement>> StartSessionAsync(string? name = null, string? roomSecret = null) =>
            CallAsync("/session/start", HttpMethod.Post, new { sessionName = name, roomSecret });
        public Task<Dictionary<string, JsonElement>> JoinSessionAsync(string sessionId, string? username = null, string? roomSecret = null) =>
            CallAsync("/session/join", HttpMethod.Post, new { sessionId, username, roomSecret });
        public Task<Dictionary<string, JsonElement>> ApproveJoinAsync(string tempUserId) =>
            CallAsync("/session/approve", HttpMethod.Post, new { tempUserId });
        public Task<Dictionary<string, JsonElement>> RejectJoinAsync(string tempUserId, string? reason = null) =>
            CallAsync("/session/reject", HttpMethod.Post, new { tempUserId, reason });
        public Task<Dictionary<string, JsonElement>> KickUserAsync(string userId) =>
            CallAsync("/session/kick", HttpMethod.Post, new { userId });
        public Task<Dictionary<string, JsonElement>> CloseSessionAsync() => CallAsync("/session/close", HttpMethod.Post);
        public Task<Dictionary<string, JsonElement>> SendFileAsync(string filePath, string? protocol = null) =>
            CallAsync("/send", HttpMethod.Post, new { filePath, protocol });
        public Task<Dictionary<string, JsonElement>> AcceptTransferAsync(string fileId, string? saveDir = null) =>
            CallAsync("/receive", HttpMethod.Post, new { fileId, saveDir });
        public Task<Dictionary<string, JsonElement>> SendChatAsync(string message) =>
            CallAsync("/chat/send", HttpMethod.Post, new { message });
        public Task<List<Dictionary<string, JsonElement>>> ChatHistoryAsync() => CallArrayAsync("/chat/history", HttpMethod.Get);
        public async Task<List<Dictionary<string, JsonElement>>> ListTransfersAsync()
        {
            var status = await StatusAsync().ConfigureAwait(false);
            if (status.TryGetValue("activeTransfers", out var transfersEl) && transfersEl.ValueKind == JsonValueKind.Array)
            {
                return JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(transfersEl.GetRawText()) ?? new();
            }
            return new();
        }

        public void Dispose() => _http.Dispose();

    }
}
