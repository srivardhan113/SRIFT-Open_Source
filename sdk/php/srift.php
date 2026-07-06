<?php
/**
 * SRIFT PHP SDK — zero-dep client. PHP 7.4+ / 8.x.
 * Runs anywhere PHP runs: Apache, Nginx+FPM, Swoole, RoadRunner, FrankenPHP, Laravel Octane.
 *
 * Usage:
 *   require_once 'srift.php';
 *   $s = new \Srift\Client();
 *   $r = $s->quickShare('/abs/path/file.zip');
 *   echo $r['shareUrl'];
 */
namespace Srift;

class SriftException extends \RuntimeException {}

class Client {
    public string $baseUrl;
    public int $timeout;

    public function __construct(?string $baseUrl = null, int $timeout = 30) {
        $this->baseUrl = rtrim($baseUrl ?? getenv('SRIFT_BASE_URL') ?: 'http://127.0.0.1:3822', '/');
        $this->timeout = $timeout;
    }

    private function call(string $path, string $method = 'GET', ?array $body = null) {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch); curl_close($ch);
            throw new SriftException("Daemon unreachable at {$this->baseUrl}: $err. Start it with: srift daemon start");
        }
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $json = $raw === '' ? [] : json_decode($raw, true);
        if ($code >= 400) throw new SriftException($json['error'] ?? "HTTP $code");
        return $json;
    }

    public function status()  { return $this->call('/status'); }
    public function state()   { return $this->call('/state'); }
    public function quickShare(string $filePath, ?string $sessionName = null) {
        return $this->call('/quick-share', 'POST', ['filePath' => $filePath, 'sessionName' => $sessionName]);
    }
    public function startSession(?string $name = null, ?string $roomSecret = null) {
        return $this->call('/session/start', 'POST', ['sessionName' => $name, 'roomSecret' => $roomSecret]);
    }
    public function joinSession(string $sessionId, ?string $username = null, ?string $roomSecret = null) {
        return $this->call('/session/join', 'POST', ['sessionId' => $sessionId, 'username' => $username, 'roomSecret' => $roomSecret]);
    }
    public function approveJoin(string $tempUserId) { return $this->call('/session/approve', 'POST', ['tempUserId' => $tempUserId]); }
    public function rejectJoin(string $tempUserId, ?string $reason = null) { return $this->call('/session/reject', 'POST', ['tempUserId' => $tempUserId, 'reason' => $reason]); }
    public function kickUser(string $userId) { return $this->call('/session/kick', 'POST', ['userId' => $userId]); }
    public function closeSession() { return $this->call('/session/close', 'POST'); }
    public function sendFile(string $filePath, ?string $protocol = null) { return $this->call('/send', 'POST', ['filePath' => $filePath, 'protocol' => $protocol]); }
    public function acceptTransfer(string $fileId, ?string $saveDir = null) { return $this->call('/receive', 'POST', ['fileId' => $fileId, 'saveDir' => $saveDir]); }
    public function sendChat(string $message) { return $this->call('/chat/send', 'POST', ['message' => $message]); }
    public function chatHistory() { return $this->call('/chat/history'); }
    public function listTransfers() {
        $status = $this->status();
        return $status['activeTransfers'] ?? [];
    }
}
