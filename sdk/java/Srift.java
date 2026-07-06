/*
 * SRIFT Java SDK — zero-dep client. Java 11+ (uses java.net.http).
 * Works on: OpenJDK, GraalVM (incl. native-image), Kotlin, Scala, Clojure, Groovy, JBang.
 *
 *   var s = new Srift();
 *   var r = s.quickShare("/abs/path/file.zip", null);
 *   System.out.println(r.get("shareUrl"));
 */
package app.srift;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

public class Srift {
    public final String baseUrl;
    private final HttpClient http;

    public Srift() { this(null); }

    public Srift(String baseUrl) {
        String fromEnv = System.getenv("SRIFT_BASE_URL");
        this.baseUrl = (baseUrl != null ? baseUrl : (fromEnv != null ? fromEnv : "http://127.0.0.1:3822")).replaceAll("/$", "");
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    public static class SriftException extends RuntimeException { public SriftException(String m) { super(m); } }

    private static String esc(String s) { return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }

    private static String toJson(Map<String, Object> m) {
        var sb = new StringBuilder("{");
        boolean first = true;
        for (var e : m.entrySet()) {
            if (e.getValue() == null) continue;
            if (!first) sb.append(",");
            sb.append(esc(e.getKey())).append(":");
            Object v = e.getValue();
            if (v instanceof String) sb.append(esc((String) v));
            else if (v instanceof Number || v instanceof Boolean) sb.append(v);
            else sb.append(esc(v.toString()));
            first = false;
        }
        return sb.append("}").toString();
    }

    /** Tiny JSON parser — returns top-level keys as strings. Sufficient for SRIFT responses. */
    public static Map<String, String> parseJson(String json) {
        var out = new HashMap<String, String>();
        if (json == null || json.isEmpty()) return out;
        int i = 0;
        while (i < json.length()) {
            int kStart = json.indexOf('"', i); if (kStart < 0) break;
            int kEnd = json.indexOf('"', kStart + 1); if (kEnd < 0) break;
            String key = json.substring(kStart + 1, kEnd);
            int colon = json.indexOf(':', kEnd); if (colon < 0) break;
            int j = colon + 1;
            while (j < json.length() && Character.isWhitespace(json.charAt(j))) j++;
            if (j >= json.length()) break;
            char c = json.charAt(j);
            String val;
            if (c == '"') {
                int s = j + 1; int e = json.indexOf('"', s);
                while (e > 0 && json.charAt(e - 1) == '\\') e = json.indexOf('"', e + 1);
                val = json.substring(s, e); i = e + 1;
            } else if (c == '{' || c == '[') {
                int depth = 1; int s = j + 1; int k = s;
                while (k < json.length() && depth > 0) {
                    char ch = json.charAt(k);
                    if (ch == '{' || ch == '[') depth++;
                    else if (ch == '}' || ch == ']') depth--;
                    k++;
                }
                val = json.substring(j, k); i = k;
            } else {
                int s = j; int e = j;
                while (e < json.length() && ",}]".indexOf(json.charAt(e)) < 0) e++;
                val = json.substring(s, e).trim(); i = e;
            }
            out.put(key, val);
        }
        return out;
    }

    private String callRaw(String path, String method, Map<String, Object> body) {
        try {
            var b = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(30));
            if ("POST".equals(method)) b.POST(HttpRequest.BodyPublishers.ofString(body == null ? "{}" : toJson(body)));
            else b.GET();
            var res = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() >= 400) throw new SriftException("HTTP " + res.statusCode() + ": " + res.body());
            return res.body();
        } catch (SriftException e) {
            throw e;
        } catch (Exception e) {
            throw new SriftException("Daemon unreachable at " + baseUrl + ". Start it with: srift daemon start. Cause: " + e.getMessage());
        }
    }

    private Map<String, String> call(String path, String method, Map<String, Object> body) {
        return parseJson(callRaw(path, method, body));
    }

    public Map<String, String> status() { return call("/status", "GET", null); }
    public Map<String, String> state() { return call("/state", "GET", null); }
    public Map<String, String> quickShare(String filePath, String sessionName) {
        return call("/quick-share", "POST", Map.of("filePath", filePath, "sessionName", sessionName == null ? "" : sessionName));
    }
    public Map<String, String> startSession(String name, String roomSecret) {
        var b = new HashMap<String, Object>(); b.put("sessionName", name); b.put("roomSecret", roomSecret);
        return call("/session/start", "POST", b);
    }
    public Map<String, String> joinSession(String sessionId, String username) {
        return call("/session/join", "POST", Map.of("sessionId", sessionId, "username", username == null ? "" : username));
    }
    public Map<String, String> joinSession(String sessionId, String username, String roomSecret) {
        var b = new HashMap<String, Object>(); b.put("sessionId", sessionId); b.put("username", username); b.put("roomSecret", roomSecret);
        return call("/session/join", "POST", b);
    }
    public Map<String, String> approveJoin(String tempUserId) { return call("/session/approve", "POST", Map.of("tempUserId", tempUserId)); }
    public Map<String, String> rejectJoin(String tempUserId, String reason) {
        var b = new HashMap<String, Object>(); b.put("tempUserId", tempUserId); if (reason != null) b.put("reason", reason);
        return call("/session/reject", "POST", b);
    }
    public Map<String, String> kickUser(String userId) { return call("/session/kick", "POST", Map.of("userId", userId)); }
    public Map<String, String> closeSession() { return call("/session/close", "POST", null); }
    public Map<String, String> sendFile(String filePath) { return call("/send", "POST", Map.of("filePath", filePath)); }
    public Map<String, String> sendFile(String filePath, String protocol) {
        var b = new HashMap<String, Object>(); b.put("filePath", filePath); if (protocol != null) b.put("protocol", protocol);
        return call("/send", "POST", b);
    }
    public Map<String, String> acceptTransfer(String fileId, String saveDir) {
        return call("/receive", "POST", Map.of("fileId", fileId, "saveDir", saveDir == null ? "" : saveDir));
    }
    public Map<String, String> sendChat(String message) { return call("/chat/send", "POST", Map.of("message", message)); }
    public String chatHistory() { return callRaw("/chat/history", "GET", null); }
    public String listTransfers() { return status().getOrDefault("activeTransfers", "[]"); }
}
