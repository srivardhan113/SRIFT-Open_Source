// Package srift is a zero-dependency Go client for the SRIFT local daemon.
//
// Compatible with: Go 1.21+, TinyGo, GopherJS, Wasm targets.
// Runs on: any OS, any cloud, any container, Lambda, Cloud Run, Fargate, k8s.
//
//	import "srift.app/sdk/go/srift"
//	c := srift.New("")
//	r, err := c.QuickShare("/abs/path/file.zip", "")
//	fmt.Println(r.ShareURL)
package srift

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const DefaultBase = "http://127.0.0.1:3822"

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func New(baseURL string) *Client {
	if baseURL == "" {
		baseURL = os.Getenv("SRIFT_BASE_URL")
	}
	if baseURL == "" {
		baseURL = DefaultBase
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) call(ctx context.Context, path, method string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("daemon unreachable at %s: %w. Start it with: srift daemon start", c.BaseURL, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		var e map[string]any
		_ = json.Unmarshal(data, &e)
		if msg, ok := e["error"].(string); ok {
			return fmt.Errorf("srift: %s", msg)
		}
		return fmt.Errorf("srift: HTTP %d", resp.StatusCode)
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

type QuickShareResult struct {
	Success   bool   `json:"success"`
	SessionID string `json:"sessionId"`
	FileID    string `json:"fileId"`
	ShareURL  string `json:"shareUrl"`
	Protocol  string `json:"protocol"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
}

type Transfer struct {
	FileID     string  `json:"fileId"`
	Name       string  `json:"name"`
	Size       int64   `json:"size"`
	Progress   float64 `json:"progress"`
	SpeedKBps  float64 `json:"speedKBps"`
	ETASeconds float64 `json:"etaSeconds"`
	Protocol   string  `json:"protocol"`
	Status     string  `json:"status"`
}

type Session struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	IsConnected bool   `json:"isConnected"`
	UserID      string `json:"userId"`
}

type Status struct {
	Session         Session    `json:"session"`
	ActiveTransfers []Transfer `json:"activeTransfers"`
	PendingJoins    []struct {
		TempUserID string `json:"tempUserId"`
		Username   string `json:"username"`
	} `json:"pendingJoins"`
	LastUpdated string `json:"lastUpdated"`
}

func (c *Client) Status(ctx context.Context) (*Status, error) {
	var out Status
	return &out, c.call(ctx, "/status", "GET", nil, &out)
}

func (c *Client) QuickShare(ctx context.Context, filePath, sessionName string) (*QuickShareResult, error) {
	var out QuickShareResult
	return &out, c.call(ctx, "/quick-share", "POST", map[string]any{"filePath": filePath, "sessionName": sessionName}, &out)
}

func (c *Client) StartSession(ctx context.Context, name, roomSecret string) error {
	return c.call(ctx, "/session/start", "POST", map[string]any{"sessionName": name, "roomSecret": roomSecret}, nil)
}

func (c *Client) JoinSession(ctx context.Context, sessionID, username, roomSecret string) error {
	return c.call(ctx, "/session/join", "POST", map[string]any{"sessionId": sessionID, "username": username, "roomSecret": roomSecret}, nil)
}

func (c *Client) ApproveJoin(ctx context.Context, tempUserID string) error {
	return c.call(ctx, "/session/approve", "POST", map[string]any{"tempUserId": tempUserID}, nil)
}

func (c *Client) RejectJoin(ctx context.Context, tempUserID, reason string) error {
	return c.call(ctx, "/session/reject", "POST", map[string]any{"tempUserId": tempUserID, "reason": reason}, nil)
}

func (c *Client) KickUser(ctx context.Context, userID string) error {
	return c.call(ctx, "/session/kick", "POST", map[string]any{"userId": userID}, nil)
}

func (c *Client) CloseSession(ctx context.Context) error {
	return c.call(ctx, "/session/close", "POST", nil, nil)
}

func (c *Client) SendFile(ctx context.Context, filePath, protocol string) (string, error) {
	var out struct {
		FileID   string `json:"fileId"`
		Protocol string `json:"protocol"`
	}
	err := c.call(ctx, "/send", "POST", map[string]any{"filePath": filePath, "protocol": protocol}, &out)
	return out.FileID, err
}

func (c *Client) AcceptTransfer(ctx context.Context, fileID, saveDir string) error {
	return c.call(ctx, "/receive", "POST", map[string]any{"fileId": fileID, "saveDir": saveDir}, nil)
}

func (c *Client) SendChat(ctx context.Context, message string) error {
	return c.call(ctx, "/chat/send", "POST", map[string]any{"message": message}, nil)
}

type ChatMessage struct {
	MessageID string `json:"messageId"`
	Sender    string `json:"sender"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

func (c *Client) ChatHistory(ctx context.Context) ([]ChatMessage, error) {
	var out []ChatMessage
	return out, c.call(ctx, "/chat/history", "GET", nil, &out)
}

func (c *Client) State(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	return out, c.call(ctx, "/state", "GET", nil, &out)
}

func (c *Client) ListTransfers(ctx context.Context) ([]Transfer, error) {
	s, err := c.Status(ctx)
	if err != nil {
		return nil, err
	}
	return s.ActiveTransfers, nil
}
