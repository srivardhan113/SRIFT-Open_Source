// cli/daemon.ts
import express from "express";
import cors from "cors";
import { WebSocket } from "ws";
import { webcrypto } from "crypto";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

// cli/mcp.ts
import http from "http";

// lib/mcp/core.mjs
var PROTOCOL_VERSION = "2025-06-18";
var MCP_TOOLS = [
  {
    name: "srift_start_session",
    title: "Start SRIFT Session",
    description: "Create a new SRIFT secure session. Returns the 7-character session ID and a shareable URL. The host approves all future joins. E2EE keys derive locally from the session ID + optional roomSecret.",
    inputSchema: {
      type: "object",
      properties: {
        sessionName: { type: "string", description: 'Human-readable session name (optional, e.g. "Project Collab")' },
        roomSecret: { type: "string", description: "Optional shared secret for extra-strong E2EE key derivation. Never sent to server." }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "7-character unique session room code" },
        url: { type: "string", description: "Direct browser join URL to share with peers" },
        role: { type: "string", description: "User role in session (host)" }
      },
      required: ["sessionId"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.9
    }
  },
  {
    name: "srift_join_session",
    title: "Join SRIFT Session",
    description: "Request to join an existing SRIFT session by its 7-character session ID. The host must approve before transfers/chat work.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "7-character session ID (e.g. ABC1234)" },
        username: { type: "string", description: "Display name (optional, defaults to AI-Agent)" },
        roomSecret: { type: "string", description: "Optional shared secret matching the host's" }
      },
      required: ["sessionId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session room code" },
        status: { type: "string", description: "Join request status (approved, pending, or joined)" },
        message: { type: "string", description: "Status message or instructions" }
      },
      required: ["sessionId"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.9
    }
  },
  {
    name: "srift_session_status",
    title: "Get Session Status",
    description: "Get current session details: id, role (host/guest), connection state, pending join requests, peer count.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Active session ID, if any" },
        role: { type: "string", description: 'Active role: "host", "guest", or null' },
        isConnected: { type: "boolean", description: "True if connected to signaling server" },
        peerCount: { type: "number", description: "Number of connected peers in the room" },
        pendingJoins: {
          type: "array",
          description: "List of pending guest join requests waiting for host approval",
          items: {
            type: "object",
            properties: {
              tempUserId: { type: "string", description: "Temporary ID of requesting user" },
              username: { type: "string", description: "Username of requesting user" }
            }
          }
        }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.8
    }
  },
  {
    name: "srift_close_session",
    title: "Close Session",
    description: "Close the active session. Flushes E2EE keys, disconnects signaling, clears chat history.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if session was closed cleanly" },
        message: { type: "string", description: "Confirmation message" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      audience: ["agent", "user"],
      priority: 0.7
    }
  },
  {
    name: "srift_approve_join",
    title: "Approve Join Request",
    description: "Host-only. Approve a pending guest join request by their temp user ID.",
    inputSchema: {
      type: "object",
      properties: {
        tempUserId: { type: "string", description: "Temp user ID from session_status pendingJoins" }
      },
      required: ["tempUserId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if guest was approved" },
        tempUserId: { type: "string", description: "Approved user temporary ID" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.8
    }
  },
  {
    name: "srift_reject_join",
    title: "Reject Join Request",
    description: "Host-only. Reject a pending guest join request.",
    inputSchema: {
      type: "object",
      properties: {
        tempUserId: { type: "string", description: "Temp user ID from session_status pendingJoins" },
        reason: { type: "string", description: "Optional rejection reason message sent to guest" }
      },
      required: ["tempUserId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if guest join request was rejected" },
        tempUserId: { type: "string", description: "Rejected user temporary ID" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      audience: ["agent", "user"],
      priority: 0.7
    }
  },
  {
    name: "srift_kick_user",
    title: "Kick Peer",
    description: "Host-only. Disconnect and ban a peer from the active room.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID of the participant to disconnect and remove" }
      },
      required: ["userId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if peer was successfully kicked" },
        userId: { type: "string", description: "ID of kicked peer" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      audience: ["agent", "user"],
      priority: 0.6
    }
  },
  {
    name: "srift_send_file",
    title: "Send File in Session",
    description: "Offer a file to the connected peer in an existing session. The peer must accept with srift_accept_transfer. Returns a fileId for monitoring. Transport is auto-selected internally.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file on local disk" }
      },
      required: ["filePath"]
    },
    outputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Unique identifier for the offered file transfer" },
        fileName: { type: "string", description: "Base filename of the offered file" },
        fileSize: { type: "number", description: "Size of file in bytes" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.9
    }
  },
  {
    name: "srift_accept_transfer",
    title: "Accept File Transfer",
    description: "Accept a pending file offer from the peer and start downloading.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "fileId from the inbound file_offer event or transfer list" },
        saveDir: { type: "string", description: "Absolute path to destination directory (defaults to CWD)" }
      },
      required: ["fileId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if transfer acceptance started successfully" },
        fileId: { type: "string", description: "Accepted transfer ID" },
        saveDir: { type: "string", description: "Destination directory path" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.9
    }
  },
  {
    name: "srift_list_transfers",
    title: "List Active Transfers",
    description: "List all active and recent transfers with progress, speed, ETA, and status.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        transfers: {
          type: "array",
          description: "List of live or recent file transfers",
          items: {
            type: "object",
            properties: {
              fileId: { type: "string", description: "Transfer unique file ID" },
              name: { type: "string", description: "Filename" },
              size: { type: "number", description: "Size in bytes" },
              progress: { type: "number", description: "Transfer percentage 0-100" },
              status: { type: "string", description: "Transfer status (uploading, downloading, completed, failed)" },
              speedKBps: { type: "number", description: "Current transfer speed in KB/s" },
              etaSeconds: { type: "number", description: "Estimated remaining seconds" }
            }
          }
        }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.8
    }
  },
  {
    name: "srift_quick_share",
    title: "Quick Share File",
    description: 'One-shot helper: if no session is active, creates one; then seeds the file and returns a public DOWNLOAD URL (https://srift.app/d/<token>) the recipient can open in any browser or curl. No install needed on their side. Best for "AI wants to deliver a file to the user with zero ceremony".',
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file to deliver to the recipient" },
        sessionName: { type: "string", description: "Optional session label for the transfer" }
      },
      required: ["filePath"]
    },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Associated session ID" },
        fileId: { type: "string", description: "Transfer file ID" },
        downloadUrl: { type: "string", description: "Public HTTP download URL for recipient" },
        fileName: { type: "string", description: "Base filename" },
        fileSize: { type: "number", description: "File size in bytes" }
      },
      required: ["downloadUrl"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 1
    }
  },
  {
    name: "srift_send_chat",
    title: "Send Encrypted Chat",
    description: "Send an end-to-end encrypted (AES-256-GCM) chat message to the connected peer.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Plaintext message string to encrypt and transmit" }
      },
      required: ["message"]
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "True if message was sent" },
        timestamp: { type: "string", description: "ISO 8601 transmission timestamp" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.8
    }
  },
  {
    name: "srift_chat_history",
    title: "Read Chat History",
    description: "Read the locally-decrypted chat log for the current session.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "Decrypted message log for current session",
          items: {
            type: "object",
            properties: {
              sender: { type: "string", description: "Sender display name" },
              message: { type: "string", description: "Decrypted plaintext content" },
              timestamp: { type: "string", description: "ISO timestamp" }
            }
          }
        }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.7
    }
  },
  {
    name: "srift_read_state",
    title: "Read Local State",
    description: "Return the raw .srift-state.json contents (session + active transfers snapshot). Useful for one-shot polling without subscribing to SSE.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        session: { type: "object", description: "Current session state snapshot" },
        activeTransfers: { type: "array", description: "Live transfers array" },
        lastUpdated: { type: "string", description: "Last state write timestamp" }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      audience: ["agent", "user"],
      priority: 0.6
    }
  }
];
var MCP_RESOURCES = [
  {
    uri: "srift://session/status",
    name: "Session Status",
    description: "Current session ID, role, connection status, pending joins",
    mimeType: "application/json"
  },
  {
    uri: "srift://transfers/active",
    name: "Active Transfers",
    description: "Uploads and downloads with live progress, speed, ETA",
    mimeType: "application/json"
  },
  {
    uri: "srift://chat/messages",
    name: "Chat History",
    description: "E2EE chat log decrypted locally",
    mimeType: "application/json"
  },
  {
    uri: "srift://workspace/state",
    name: "Workspace State Snapshot",
    description: "Raw .srift-state.json contents",
    mimeType: "application/json"
  },
  {
    uri: "srift://docs/quickstart",
    name: "Quickstart Instructions",
    description: "Inline guide for AI agents on how to use this MCP server",
    mimeType: "text/markdown"
  }
];
var MCP_PROMPTS = [
  {
    name: "send_file_to_user",
    description: "Workflow: create a session, seed a file, hand the user a share URL.",
    arguments: [
      { name: "filePath", description: "Absolute path to the file you want to deliver", required: true }
    ]
  },
  {
    name: "receive_file_from_user",
    description: "Workflow: open a session and wait for the user to drop files into it.",
    arguments: [
      { name: "saveDir", description: "Where to save incoming files", required: false }
    ]
  },
  {
    name: "start_collab_session",
    description: "Workflow: open a long-lived E2EE chat + file room with the user.",
    arguments: [
      { name: "sessionName", description: "Label for the room", required: false }
    ]
  }
];
function buildPromptMessages(name, args) {
  switch (name) {
    case "send_file_to_user":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Deliver the file at "${args?.filePath || "<filePath>"}" to the user via SRIFT.

1) Call srift_quick_share with filePath="${args?.filePath || "<filePath>"}".
2) Read the returned share URL aloud to the user.
3) Poll srift_list_transfers (or read srift://transfers/active) until status is "completed".`
        }
      }];
    case "receive_file_from_user":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Open a SRIFT room and wait for the user to send you files.

1) Call srift_start_session.
2) Give the user the join URL: https://srift.app/join-session?id=<SESSION_ID> (full session UI with chat + multi-file transfer).
   Or, for a single one-shot file from agent \u2192 user, prefer srift_quick_share which returns a direct download URL.
3) Poll srift_session_status; when pendingJoins appears, call srift_approve_join.
4) When a file_offer arrives (visible via srift_list_transfers), call srift_accept_transfer with saveDir="${args?.saveDir || "./"}".`
        }
      }];
    case "start_collab_session":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Open a SRIFT collaboration room named "${args?.sessionName || "AI-Collab"}" and use it for E2EE chat + ad-hoc file transfer with the user.

1) srift_start_session({ sessionName: "${args?.sessionName || "AI-Collab"}" })
2) Share the join URL.
3) If srift_send_chat / srift_send_file are available on this transport, use them directly. Otherwise (hosted/remote MCP), tell the user to open the join URL in their browser or CLI \u2014 chat and file transfer happen E2EE between the real peers, never through this server.
4) Use srift_accept_transfer as needed when running locally.`
        }
      }];
  }
  return [];
}
var QUICKSTART_DOC = `# SRIFT MCP Quickstart for AI Agents

You are connected to SRIFT \u2014 a zero-config, zero-token, peer-to-peer secure file transfer + E2EE chat layer.

## Common workflows

**Send a file to the user (fastest path \u2014 zero install on their side):**
\`\`\`
srift_quick_share({ filePath: "/abs/path/file.zip" })
\u2192 returns { downloadUrl, fileName, fileSize }
\u2192 paste downloadUrl to the user (https://srift.app/d/<token>)
\u2192 they open it in any browser, or run:
    curl -OJ <downloadUrl>
    wget --content-disposition <downloadUrl>
\u2192 IMPORTANT: the local daemon seeds the file. It keeps running in the
  background after your tool call returns, so the link stays live. But if
  the daemon stops (machine sleeps/reboots, or 'srift daemon stop') the link
  returns 503 "sender is offline" \u2014 SRIFT stores no copy server-side.
  Tell the user to download while their machine is on.
\`\`\`

**Open a long-lived collaboration room:**
\`\`\`
srift_start_session({ sessionName: "AI-Collab" })
\u2192 returns { sessionId }
\u2192 user joins via https://srift.app/join-session?id=<sessionId>
\u2192 host (you) calls srift_approve_join when pendingJoins appears
\`\`\`

**Receive a file from the user:**
The user clicks the share link, requests join, you approve, they drop a file,
you see it via srift_list_transfers and call srift_accept_transfer.

## Monitoring
- Poll \`srift_session_status\` or read resource \`srift://session/status\`.
- Poll \`srift_list_transfers\` or read \`srift://transfers/active\`.
- Live state snapshot: \`srift_read_state\` or \`srift://workspace/state\` (local daemon only).

## Security model
- AES-256-GCM, 12-byte random IV per message.
- PBKDF2-SHA256, 100,000 iterations.
- All keys derive locally from sessionId (+ optional roomSecret). Server never sees them.
- File chunks transit P2P (WebTorrent for >10MB, WebSocket-relay fallback otherwise).

## Local daemon vs hosted MCP
If you are talking to the hosted endpoint (https://srift.app/mcp) instead of a local
\`srift mcp\` daemon, file-transfer tools that require a local filesystem
(srift_send_file, srift_accept_transfer, srift_quick_share) and E2EE chat tools
(srift_send_chat, srift_chat_history) are NOT available \u2014 the hosted server
never touches plaintext file bytes or derives E2EE keys, only session/peer
orchestration. Install the CLI (\`curl -fsSL https://srift.app/install.sh | sh\`)
for full file-transfer + chat capability.
`;
function resp(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function errResp(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function createMcpHandler(opts) {
  const { backend, serverInfo, instructions } = opts;
  const tools = opts.toolNames ? MCP_TOOLS.filter((t) => opts.toolNames.has(t.name)) : MCP_TOOLS;
  const resources = opts.resourceUris ? MCP_RESOURCES.filter((r) => opts.resourceUris.has(r.uri)) : MCP_RESOURCES;
  const prompts = opts.promptNames ? MCP_PROMPTS.filter((p) => opts.promptNames.has(p.name)) : MCP_PROMPTS;
  const toolSet = new Set(tools.map((t) => t.name));
  const resourceSet = new Set(resources.map((r) => r.uri));
  const promptSet = new Set(prompts.map((p) => p.name));
  return async function handleMcpMessage2(message, ctx = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return errResp(null, -32600, "Invalid Request");
    }
    const { id, method, params } = message;
    if (id === void 0 || id === null) {
      return null;
    }
    if (typeof method !== "string") {
      return errResp(id, -32600, "Invalid Request: method must be a string");
    }
    try {
      if (method === "initialize") {
        return resp(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            prompts: { listChanged: false },
            logging: {}
          },
          serverInfo,
          instructions
        });
      }
      if (method === "ping") {
        return resp(id, {});
      }
      if (method === "tools/list") {
        return resp(id, { tools });
      }
      if (method === "tools/call") {
        const { name, arguments: args = {} } = params || {};
        if (typeof name !== "string") {
          return errResp(id, -32602, "Invalid params: tool name required");
        }
        if (!toolSet.has(name)) {
          return resp(id, {
            isError: true,
            content: [{ type: "text", text: `Tool "${name}" is not available on this transport.` }]
          });
        }
        const text = await backend.callTool(name, args, ctx);
        return resp(id, { content: [{ type: "text", text }] });
      }
      if (method === "resources/list") {
        return resp(id, { resources });
      }
      if (method === "resources/read") {
        const { uri } = params || {};
        if (typeof uri !== "string" || !resourceSet.has(uri)) {
          return errResp(id, -32602, `Resource not found: ${uri}`);
        }
        const content = await backend.readResource(uri, ctx);
        return resp(id, {
          contents: [{
            uri,
            mimeType: uri === "srift://docs/quickstart" ? "text/markdown" : "application/json",
            text: content
          }]
        });
      }
      if (method === "prompts/list") {
        return resp(id, { prompts });
      }
      if (method === "prompts/get") {
        const { name, arguments: args = {} } = params || {};
        if (typeof name !== "string" || !promptSet.has(name)) {
          return errResp(id, -32602, `Prompt not found: ${name}`);
        }
        const messages = buildPromptMessages(name, args);
        return resp(id, {
          description: prompts.find((p) => p.name === name)?.description || "",
          messages
        });
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return null;
      }
      return errResp(id, -32601, `Method not found: ${method}`);
    } catch (err) {
      if (method === "tools/call") {
        return resp(id, { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] });
      }
      return errResp(id, -32603, err.message || "Internal error");
    }
  };
}

// cli/mcp.ts
var DAEMON_PORT = parseInt(process.env.SRIFT_DAEMON_PORT || "3822", 10);
var DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
var SERVER_INFO = {
  name: "srift-mcp-server",
  title: "SRIFT Secure P2P File Transfer",
  version: "2.2.15"
};
function callDaemon(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const url = `${DAEMON_URL}${endpoint}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ success: true });
          }
        } else {
          try {
            const errJson = JSON.parse(data);
            reject(new Error(errJson.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });
    req.on("error", (err) => reject(new Error(`Daemon connection failed: ${err.message}`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function callTool(name, args) {
  switch (name) {
    case "srift_start_session": {
      const res = await callDaemon("/session/start", "POST", {
        sessionName: args.sessionName,
        roomSecret: args.roomSecret
      });
      return `Session created.
Session ID: ${res.sessionId}
Share URL: https://srift.app/join-session?id=${res.sessionId}
You are the HOST. Approve incoming joins with srift_approve_join.`;
    }
    case "srift_join_session": {
      const res = await callDaemon("/session/join", "POST", args);
      return `Join requested for session ${args.sessionId}. Status: ${res.success ? "awaiting host approval" : "failed"}.`;
    }
    case "srift_session_status": {
      const res = await callDaemon("/status", "GET");
      return JSON.stringify({ session: res.session, pendingJoins: res.pendingJoins }, null, 2);
    }
    case "srift_close_session":
      await callDaemon("/session/close", "POST");
      return "Session closed. Keys flushed.";
    case "srift_approve_join":
      await callDaemon("/session/approve", "POST", args);
      return `Approved ${args.tempUserId}.`;
    case "srift_reject_join":
      await callDaemon("/session/reject", "POST", args);
      return `Rejected ${args.tempUserId}.`;
    case "srift_kick_user":
      await callDaemon("/session/kick", "POST", args);
      return `Kicked ${args.userId}.`;
    case "srift_send_file": {
      const res = await callDaemon("/send", "POST", args);
      return `File offered.
File ID: ${res.fileId}
The peer must call srift_accept_transfer with this fileId.`;
    }
    case "srift_accept_transfer":
      await callDaemon("/receive", "POST", args);
      return `Transfer ${args.fileId} accepted. Downloading\u2026`;
    case "srift_list_transfers": {
      const res = await callDaemon("/status", "GET");
      return JSON.stringify(res.activeTransfers || [], null, 2);
    }
    case "srift_quick_share": {
      const res = await callDaemon("/quick-share", "POST", args);
      const url = res.downloadUrl || res.shareUrl;
      return [
        `Quick share ready.`,
        `Download URL: ${url}`,
        `File:         ${res.fileName} (${res.fileSize} bytes)`,
        ``,
        `Give the URL to the user \u2014 they open it in any browser, or run:`,
        `  curl -OJ "${url}"`,
        ``,
        `The daemon seeds this file from disk and keeps running in the`,
        `background, so the link stays live after this call returns.`,
        `It stops working if the daemon stops (machine sleeps/reboots, or`,
        `\`srift daemon stop\`) \u2014 SRIFT keeps no server-side copy, so the link`,
        `then returns 503 "sender is offline". Tell the user to grab it while`,
        `this machine is on.`
      ].join("\n");
    }
    case "srift_send_chat":
      await callDaemon("/chat/send", "POST", args);
      return `Sent (E2EE): "${args.message}"`;
    case "srift_chat_history": {
      const res = await callDaemon("/chat/history", "GET");
      return JSON.stringify(res, null, 2);
    }
    case "srift_read_state": {
      const res = await callDaemon("/state", "GET");
      return JSON.stringify(res, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
async function readResource(uri) {
  if (uri === "srift://session/status") {
    const res = await callDaemon("/status", "GET");
    return JSON.stringify(res.session, null, 2);
  }
  if (uri === "srift://transfers/active") {
    const res = await callDaemon("/status", "GET");
    return JSON.stringify(res.activeTransfers || [], null, 2);
  }
  if (uri === "srift://chat/messages") {
    const res = await callDaemon("/chat/history", "GET");
    return JSON.stringify(res, null, 2);
  }
  if (uri === "srift://workspace/state") {
    const res = await callDaemon("/state", "GET");
    return JSON.stringify(res, null, 2);
  }
  if (uri === "srift://docs/quickstart") {
    return QUICKSTART_DOC;
  }
  throw new Error(`Resource not found: ${uri}`);
}
var localDaemonBackend = { callTool, readResource };
var handleMcpMessage = createMcpHandler({
  backend: localDaemonBackend,
  serverInfo: SERVER_INFO,
  instructions: "SRIFT is a zero-config local P2P file transfer + E2EE chat tool. Use srift_quick_share to deliver files to the user in one step. Use srift_start_session to open a long-lived room. Read srift://docs/quickstart for the full guide."
});

// cli/daemon.ts
var _WebTorrentCtor = null;
var _webTorrentLoadError = null;
async function loadWebTorrent() {
  if (_WebTorrentCtor) return _WebTorrentCtor;
  if (_webTorrentLoadError) throw new Error(_webTorrentLoadError);
  try {
    const mod = await import("webtorrent");
    _WebTorrentCtor = mod.default || mod;
    return _WebTorrentCtor;
  } catch (err) {
    _webTorrentLoadError = `WebTorrent unavailable (likely missing native module): ${err?.message || err}`;
    console.error("[DAEMON]", _webTorrentLoadError);
    throw new Error(_webTorrentLoadError);
  }
}
var logPath = path.join(process.cwd(), ".srift-daemon.log");
var logStream = fs.createWriteStream(logPath, { flags: "a" });
var logMessage = (level, message) => {
  logStream.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] ${message}
`);
};
console.log = (...args) => {
  logMessage("INFO", args.map((arg) => typeof arg === "object" ? JSON.stringify(arg) : arg).join(" "));
};
console.error = (...args) => {
  logMessage("ERROR", args.map((arg) => typeof arg === "object" ? JSON.stringify(arg) : arg).join(" "));
};
console.warn = (...args) => {
  logMessage("WARN", args.map((arg) => typeof arg === "object" ? JSON.stringify(arg) : arg).join(" "));
};
var crypto = globalThis.crypto || webcrypto;
dotenv.config({ path: ".env.local" });
dotenv.config();
process.on("uncaughtException", (err) => {
  console.error("[DAEMON] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[DAEMON] Unhandled Rejection at:", promise, "reason:", reason);
});
var PORT = parseInt(process.env.SRIFT_DAEMON_PORT || "3822", 10);
var DEFAULT_SIGNALER_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8080";
var activeSignalerUrl = DEFAULT_SIGNALER_URL;
async function selectSignalerUrl() {
  if (DEFAULT_SIGNALER_URL.includes("127.0.0.1") || DEFAULT_SIGNALER_URL.includes("localhost")) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 1e3);
      await fetch(DEFAULT_SIGNALER_URL, { signal: controller.signal });
      clearTimeout(id);
      console.log(`[DAEMON] Local signaler detected at ${DEFAULT_SIGNALER_URL}`);
    } catch (e) {
      console.log(`[DAEMON] Local signaler at ${DEFAULT_SIGNALER_URL} is unreachable. Falling back to production signaler: https://srift.app`);
      activeSignalerUrl = "https://srift.app";
    }
  }
}
var session = {
  id: null,
  name: null,
  role: null,
  isConnected: false,
  userId: null
};
var activeTransfers = [];
var chatHistory = [];
var pendingJoins = [];
var sseClients = [];
var wsConn = null;
var wsUrl = null;
var csrfToken = null;
var heartbeatInterval = null;
var lastHeartbeatAckAt = 0;
var encryptionKey = null;
var sessionTerminated = false;
var terminationReason = null;
var activeTorrents = /* @__PURE__ */ new Map();
var wtClient = null;
var pubshares = /* @__PURE__ */ new Map();
var pubsharesByToken = /* @__PURE__ */ new Map();
var activePulls = /* @__PURE__ */ new Map();
var pubshareRegResolvers = /* @__PURE__ */ new Map();
async function getWtClient() {
  if (!wtClient) {
    const WTCtor = await loadWebTorrent();
    wtClient = new WTCtor();
  }
  return wtClient;
}
var TEMP_DIR = path.join(process.cwd(), ".srift-temp");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
var KDF_ITERATIONS = 1e5;
var IV_LEN = 12;
function bytesToBase64(bytes) {
  let binary = "";
  const CH = 32768;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CH))
    );
  }
  return Buffer.from(binary, "binary").toString("base64");
}
function base64ToBytes(b64) {
  const binary = Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
async function deriveKey(sessionId, roomSecret) {
  const encoder = new TextEncoder();
  const salt = encoder.encode(
    "srift-salt-" + sessionId + (roomSecret ? "|rs|" + roomSecret : "")
  );
  const ikm = encoder.encode(sessionId + (roomSecret ? "::" + roomSecret : ""));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encrypt(message) {
  if (!encryptionKey) throw new Error("Key not derived");
  const data = new TextEncoder().encode(message);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, data);
  const ct = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv);
  combined.set(ct, iv.length);
  return bytesToBase64(combined);
}
async function decrypt(encB64) {
  if (!encryptionKey) throw new Error("Key not derived");
  const combined = base64ToBytes(encB64);
  const iv = combined.slice(0, IV_LEN);
  const ciphertext = combined.slice(IV_LEN);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}
function getTrackers(sessionId) {
  const list = [];
  try {
    const signalerUrl = wsUrl || activeSignalerUrl;
    const trackerUrl = signalerUrl.replace(/^http/, "ws").replace(/\/ws$/, "/announce");
    if (trackerUrl) list.push(trackerUrl);
  } catch {
  }
  list.push("wss://tracker.webtorrent.dev");
  return list;
}
function writeStateFile() {
  const statePath = path.join(process.cwd(), ".srift-state.json");
  const stateData = {
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
      isConnected: session.isConnected,
      peerCount: session.role ? 1 : 0
      // simplified peer calculation
    },
    activeTransfers: activeTransfers.map((t) => ({
      fileId: t.fileId,
      name: t.name,
      size: t.size,
      progress: parseFloat(t.progress.toFixed(2)),
      speedKBps: parseFloat(t.speedKBps.toFixed(2)),
      etaSeconds: Math.ceil(t.etaSeconds),
      protocol: t.protocol,
      status: t.status
    })),
    lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
  };
  fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2), "utf-8");
}
function broadcastSSE(event, data) {
  const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
  sseClients.forEach((res) => res.write(payload));
}
function connectWebSocket(wsTargetUrl) {
  if (wsConn) {
    try {
      wsConn.close();
    } catch {
    }
  }
  console.log(`[DAEMON] Connecting to Signaler WS: ${wsTargetUrl}`);
  wsConn = new WebSocket(wsTargetUrl);
  wsConn.on("open", () => {
    console.log("[DAEMON] WebSocket connection open");
    session.isConnected = true;
    writeStateFile();
    broadcastSSE("connection_state", {
      sessionId: session.id,
      isConnected: true,
      signaling: "connected"
    });
    setTimeout(() => {
      if (session.role === "host") {
        wsConn?.send(JSON.stringify({
          type: "init_host",
          payload: { userId: session.userId, sessionId: session.id }
        }));
      } else if (session.role === "guest") {
        if (session.userId) {
          wsConn?.send(JSON.stringify({
            type: "init_joiner",
            payload: { userId: session.userId, sessionId: session.id }
          }));
        } else {
          const username = process.env.SRIFT_USERNAME || "CLI-Agent";
          wsConn?.send(JSON.stringify({
            type: "request_join",
            payload: { sessionId: session.id, tempUserId: session.tempUserId, username }
          }));
        }
      }
    }, 100);
    lastHeartbeatAckAt = Date.now();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (wsConn?.readyState === WebSocket.OPEN) {
        wsConn.send(JSON.stringify({ type: "heartbeat", payload: { ts: Date.now() } }));
      }
    }, 3e4);
  });
  wsConn.on("message", async (dataStr) => {
    try {
      const msg = JSON.parse(dataStr);
      const { type, payload } = msg;
      switch (type) {
        case "init_host_ack":
          if (payload.status === "ok") {
            csrfToken = payload.csrfToken;
            console.log("[DAEMON] Host authentication OK, CSRF Token obtained");
            reregisterPubsharesAfterReconnect().catch((e) => console.warn("[DAEMON] pubshare replay failed:", e?.message));
          }
          break;
        case "request_join_ack":
          console.log("[DAEMON] Join request received by server. Waiting for host approval...");
          break;
        case "join_approved":
          console.log("[DAEMON] Host approved join request!");
          session.userId = payload.userId;
          wsConn?.send(JSON.stringify({
            type: "init_joiner",
            payload: { userId: session.userId, sessionId: session.id }
          }));
          writeStateFile();
          break;
        case "init_joiner_ack":
          if (payload.status === "ok") {
            csrfToken = payload.csrfToken;
            console.log("[DAEMON] Approved joiner authentication OK");
          }
          break;
        case "heartbeat_ack":
          lastHeartbeatAckAt = Date.now();
          break;
        case "session_deleted":
          console.log(`[DAEMON] Session deleted by host: ${payload.reason || ""}`);
          sessionTerminated = true;
          terminationReason = payload.message || "Session was deleted by the host";
          session = { id: null, name: null, role: null, isConnected: false, userId: null };
          activeTransfers = [];
          pendingJoins = [];
          encryptionKey = null;
          writeStateFile();
          broadcastSSE("session_terminated", { reason: terminationReason });
          try {
            if (wsConn) wsConn.close();
          } catch {
          }
          break;
        case "error":
          console.error(`[DAEMON] Server error: ${payload.msg} (severity=${payload.severity || "recoverable"})`);
          if (payload.severity === "critical") {
            sessionTerminated = true;
            terminationReason = payload.msg || "Connection terminated by host";
            session.isConnected = false;
            session.userId = null;
            pendingJoins = [];
            writeStateFile();
            broadcastSSE("session_terminated", { reason: terminationReason });
          }
          break;
        case "join_request":
          console.log(`[DAEMON] Peer join request: tempUserId=${payload.tempUserId}, username=${payload.username}`);
          pendingJoins.push({ tempUserId: payload.tempUserId, username: payload.username });
          broadcastSSE("join_request", payload);
          break;
        case "chat":
          try {
            const decContent = await decrypt(payload.content);
            const chatMsg = {
              messageId: payload.messageId || uuidv4(),
              sender: payload.username || "Peer",
              content: decContent,
              timestamp: payload.timestamp || (/* @__PURE__ */ new Date()).toISOString()
            };
            chatHistory.push(chatMsg);
            broadcastSSE("chat_received", chatMsg);
            console.log(`[DAEMON] Chat from ${chatMsg.sender}: ${chatMsg.content}`);
          } catch (decErr) {
            console.error("[DAEMON] Decryption failed for chat message:", decErr);
          }
          break;
        case "file_offer":
          console.log(`[DAEMON] File offer received: ${payload.filename} (${payload.size} bytes)`);
          const newTx = {
            fileId: payload.fileId,
            name: payload.filename,
            size: payload.size,
            progress: 0,
            speedKBps: 0,
            etaSeconds: 0,
            protocol: payload.transferType === "webtorrent" ? "webtorrent" : "websocket",
            status: "pending",
            direction: "download",
            bytesTransferred: 0,
            chunksCount: 0,
            totalChunks: 0,
            startTime: Date.now()
          };
          activeTransfers.push(newTx);
          writeStateFile();
          broadcastSSE("file_offer", {
            fileId: payload.fileId,
            filename: payload.filename,
            size: payload.size,
            from: payload.from,
            protocol: newTx.protocol
          });
          break;
        case "file_accept":
          console.log(`[DAEMON] File offer accepted by peer! ID: ${payload.fileId}`);
          startUpload(payload.fileId, payload.userId);
          break;
        case "webtorrent_info_hash":
          handleWebTorrentInfoHash(payload);
          break;
        case "file_chunk":
          handleIncomingChunk(payload);
          break;
        case "file_chunk_ack":
          handleChunkAck(payload);
          break;
        case "file_complete":
          handleFileComplete(payload);
          break;
        case "pubshare_register_ack": {
          const entry = pubshares.get(payload.fileId);
          if (entry) {
            entry.token = payload.token;
            entry.downloadUrl = payload.downloadUrl;
            pubsharesByToken.set(payload.token, entry);
            const resolver = pubshareRegResolvers.get(payload.fileId);
            if (resolver) {
              pubshareRegResolvers.delete(payload.fileId);
              resolver(entry);
            }
            console.log(`[DAEMON] pubshare registered: ${entry.filename} -> ${entry.downloadUrl}`);
          }
          break;
        }
        case "pubshare_pull": {
          handlePubsharePull(payload).catch((err) => {
            console.error("[DAEMON] pubshare_pull failed:", err);
            try {
              wsConn?.send(JSON.stringify({
                type: "pubshare_end",
                payload: { requestId: payload.requestId, ok: false, error: String(err?.message || err) }
              }));
            } catch {
            }
          });
          break;
        }
        case "pubshare_cancel": {
          const a = activePulls.get(payload.requestId);
          if (a) a.cancelled = true;
          break;
        }
      }
    } catch (err) {
      console.error("[DAEMON] Error processing WS message:", err);
    }
  });
  wsConn.on("close", () => {
    console.log("[DAEMON] WebSocket connection closed");
    session.isConnected = false;
    writeStateFile();
    broadcastSSE("connection_state", {
      sessionId: session.id,
      isConnected: false,
      signaling: "disconnected"
    });
    if (sessionTerminated) {
      console.log(`[DAEMON] Not reconnecting \u2014 session terminated: ${terminationReason}`);
      return;
    }
    setTimeout(() => {
      if (session.id && wsTargetUrl && !sessionTerminated) {
        connectWebSocket(wsTargetUrl);
      }
    }, 3e3);
  });
  wsConn.on("error", (err) => {
    console.error("[DAEMON] WebSocket error:", err);
  });
}
function startUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  if (tx.protocol === "webtorrent") {
    startWebTorrentUpload(fileId, targetUserId);
  } else {
    startWebSocketUpload(fileId, targetUserId);
  }
}
async function startWebTorrentUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;
  console.log(`[DAEMON] Starting WebTorrent seeding for ${tx.name}...`);
  tx.status = "uploading";
  tx.startTime = Date.now();
  writeStateFile();
  let client;
  try {
    client = await getWtClient();
  } catch (err) {
    console.error(`[DAEMON] WebTorrent unavailable, falling back to WebSocket for ${tx.name}: ${err?.message}`);
    tx.protocol = "websocket";
    writeStateFile();
    return;
  }
  const trackers = getTrackers(session.id || "");
  client.seed(tx.filePath, { announce: trackers }, (torrent) => {
    console.log(`[DAEMON] WebTorrent seeding active. Info Hash: ${torrent.infoHash}`);
    activeTorrents.set(fileId, torrent);
    wsConn?.send(JSON.stringify({
      type: "webtorrent_info_hash",
      payload: {
        fileId,
        infoHash: torrent.infoHash,
        fileName: tx.name,
        fileSize: tx.size,
        targetUserId
      }
    }));
    torrent.on("upload", () => {
      tx.bytesTransferred = torrent.uploaded;
      tx.progress = Math.min(99.9, torrent.uploaded / tx.size * 100);
      tx.speedKBps = torrent.uploadSpeed / 1024;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.uploaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.uploadSpeed,
        timeRemainingSeconds: -1,
        status: "uploading"
      });
    });
  });
}
async function handleWebTorrentInfoHash(payload) {
  const { fileId, infoHash, fileName, fileSize, senderId } = payload;
  console.log(`[DAEMON] Received WebTorrent info hash: ${infoHash} for file: ${fileName}`);
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  tx.protocol = "webtorrent";
  tx.status = "downloading";
  tx.peerId = senderId;
  tx.startTime = Date.now();
  writeStateFile();
  let client;
  try {
    client = await getWtClient();
  } catch (err) {
    console.error(`[DAEMON] WebTorrent unavailable for download of ${fileName}: ${err?.message}. Ask the sender to retry with --protocol websocket.`);
    tx.status = "error";
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: 0,
      progress: 0,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: -1,
      status: "error"
    });
    return;
  }
  const trackers = getTrackers(session.id || "");
  const downloadDir = tx.saveDir || process.cwd();
  client.add(infoHash, { announce: trackers, path: downloadDir }, (torrent) => {
    console.log(`[DAEMON] WebTorrent download started: ${torrent.name}`);
    activeTorrents.set(fileId, torrent);
    torrent.on("download", () => {
      tx.bytesTransferred = torrent.downloaded;
      tx.progress = torrent.progress * 100;
      tx.speedKBps = torrent.downloadSpeed / 1024;
      tx.etaSeconds = torrent.timeRemaining / 1e3;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.downloaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.downloadSpeed,
        timeRemainingSeconds: tx.etaSeconds,
        status: "downloading"
      });
    });
    torrent.on("done", () => {
      console.log(`[DAEMON] WebTorrent download finished: ${tx.name}`);
      tx.status = "completed";
      tx.progress = 100;
      tx.speedKBps = 0;
      tx.etaSeconds = 0;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: tx.size,
        progress: 100,
        speedBytesPerSecond: 0,
        timeRemainingSeconds: 0,
        status: "completed"
      });
      torrent.destroy();
      activeTorrents.delete(fileId);
    });
  });
}
var activeUploads = /* @__PURE__ */ new Map();
async function startWebSocketUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;
  const chunkSize = 64 * 1024;
  const stat = fs.statSync(tx.filePath);
  const totalChunks = Math.max(1, Math.ceil(stat.size / chunkSize));
  tx.status = "uploading";
  tx.startTime = Date.now();
  tx.totalChunks = totalChunks;
  writeStateFile();
  activeUploads.set(fileId, {
    filePath: tx.filePath,
    totalChunks,
    chunkSize,
    targetUserId,
    currentChunk: 0,
    bytesSent: 0,
    startTime: Date.now()
  });
  sendNextChunk(fileId);
}
function sendNextChunk(fileId) {
  const upload = activeUploads.get(fileId);
  if (!upload) return;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  if (upload.currentChunk >= upload.totalChunks) {
    wsConn?.send(JSON.stringify({
      type: "file_complete",
      payload: { fileId, targetUserId: upload.targetUserId }
    }));
    tx.status = "completed";
    tx.progress = 100;
    tx.speedKBps = 0;
    tx.etaSeconds = 0;
    writeStateFile();
    activeUploads.delete(fileId);
    console.log(`[DAEMON] File upload complete: ${tx.name}`);
    return;
  }
  const start = upload.currentChunk * upload.chunkSize;
  const stat = fs.statSync(upload.filePath);
  const end = Math.min(start + upload.chunkSize, stat.size);
  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(upload.filePath, "r");
  fs.readSync(fd, buffer, 0, end - start, start);
  fs.closeSync(fd);
  const chunkBase64 = buffer.toString("base64");
  wsConn?.send(JSON.stringify({
    type: "file_chunk",
    payload: {
      fileId,
      chunk: chunkBase64,
      chunkIndex: upload.currentChunk,
      totalChunks: upload.totalChunks,
      targetUserId: upload.targetUserId
    }
  }));
  tx.bytesTransferred = end;
  tx.progress = end / stat.size * 100;
  const elapsed = (Date.now() - upload.startTime) / 1e3;
  if (elapsed > 0) {
    tx.speedKBps = end / 1024 / elapsed;
    tx.etaSeconds = (stat.size - end) / (tx.speedKBps * 1024);
  }
  writeStateFile();
  broadcastSSE("transfer_progress", {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: end,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: "uploading"
  });
}
function handleChunkAck(payload) {
  const { fileId, chunkIndex } = payload;
  const upload = activeUploads.get(fileId);
  if (!upload) return;
  if (upload.currentChunk === chunkIndex) {
    upload.currentChunk++;
    sendNextChunk(fileId);
  }
}
function handleIncomingChunk(payload) {
  const { fileId, chunk, chunkIndex, totalChunks, from } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  tx.status = "downloading";
  tx.totalChunks = totalChunks;
  tx.peerId = from;
  const chunkBuffer = Buffer.from(chunk, "base64");
  tx.bytesTransferred += chunkBuffer.length;
  tx.chunksCount++;
  const chunkPath = path.join(TEMP_DIR, `${fileId}_chunk_${chunkIndex}`);
  fs.writeFileSync(chunkPath, chunkBuffer);
  tx.progress = tx.bytesTransferred / tx.size * 100;
  const elapsed = (Date.now() - tx.startTime) / 1e3;
  if (elapsed > 0) {
    tx.speedKBps = tx.bytesTransferred / 1024 / elapsed;
    tx.etaSeconds = (tx.size - tx.bytesTransferred) / (tx.speedKBps * 1024);
  }
  writeStateFile();
  broadcastSSE("transfer_progress", {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: tx.bytesTransferred,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: "downloading"
  });
  wsConn?.send(JSON.stringify({
    type: "file_chunk_ack",
    payload: { fileId, chunkIndex, status: "received" }
  }));
}
function handleFileComplete(payload) {
  const { fileId } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  const destDir = tx.saveDir || process.cwd();
  const destPath = path.join(destDir, tx.name);
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[DAEMON] Failed to create destination directory ${destDir}:`, err);
    tx.status = "error";
    writeStateFile();
    return;
  }
  const writeStream = fs.createWriteStream(destPath);
  writeStream.on("error", (err) => {
    console.error(`[DAEMON] Write stream error for ${destPath}:`, err);
    tx.status = "error";
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.bytesTransferred,
      progress: tx.progress,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: 0,
      status: "error"
    });
  });
  writeStream.on("finish", () => {
    console.log(`[DAEMON] File successfully downloaded and assembled: ${destPath}`);
    tx.status = "completed";
    tx.progress = 100;
    tx.speedKBps = 0;
    tx.etaSeconds = 0;
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.size,
      progress: 100,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: 0,
      status: "completed"
    });
  });
  for (let i = 0; i < tx.totalChunks; i++) {
    const chunkPath = path.join(TEMP_DIR, `${fileId}_chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      try {
        const chunkBuf = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuf);
        fs.unlinkSync(chunkPath);
      } catch (err) {
        console.error(`[DAEMON] Error reading/writing chunk ${i}:`, err);
        writeStream.emit("error", err);
        return;
      }
    }
  }
  writeStream.end();
}
var app = express();
app.use(cors());
app.use(express.json());
var DAEMON_START_TIME = Date.now();
var PACKAGE_VERSION = "2.1.8";
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: PACKAGE_VERSION,
    uptime_ms: Date.now() - DAEMON_START_TIME,
    mcp: true,
    webrtc: false,
    // daemon uses WebSocket relay + WebTorrent, not raw WebRTC
    webtorrent: _webTorrentLoadError ? false : true,
    webtorrent_error: _webTorrentLoadError || void 0
  });
});
app.get("/status", (req, res) => {
  res.json({
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
      isConnected: session.isConnected,
      userId: session.userId
    },
    activeTransfers,
    pendingJoins,
    lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.post("/session/start", async (req, res) => {
  try {
    const { sessionName, username, roomSecret } = req.body;
    const sName = sessionName || "cli-session";
    const uName = username || "CLI-Host";
    sessionTerminated = false;
    terminationReason = null;
    console.log(`[DAEMON] Starting session: "${sName}" by "${uName}"`);
    const response = await fetch(`${activeSignalerUrl}/create-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: uName, name: sName })
    });
    if (!response.ok) {
      throw new Error(`Signaler returned status ${response.status}`);
    }
    const data = await response.json();
    console.log("[DAEMON] Session created successfully on server", data);
    session = {
      id: data.sessionId,
      name: data.name,
      role: "host",
      isConnected: false,
      userId: data.userId,
      wsToken: data.wsToken,
      roomSecret: roomSecret || null
    };
    encryptionKey = await deriveKey(data.sessionId, roomSecret);
    console.log("[DAEMON] E2EE Cryptographic key derived");
    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);
    writeStateFile();
    res.json({ success: true, sessionId: data.sessionId });
  } catch (err) {
    console.error("[DAEMON] Failed to start session:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/session/join", async (req, res) => {
  try {
    const { sessionId, username, roomSecret } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: "sessionId required" });
    }
    sessionTerminated = false;
    terminationReason = null;
    const uName = username || "CLI-Guest";
    console.log(`[DAEMON] Joining session: "${sessionId}" as "${uName}"`);
    const response = await fetch(`${activeSignalerUrl}/join-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, username: uName })
    });
    if (!response.ok) {
      let errBody = {};
      try {
        errBody = await response.json();
      } catch {
      }
      const errMsg = errBody.error || `Signaler returned status ${response.status}`;
      const statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      return res.status(statusCode).json({ success: false, error: errMsg });
    }
    const data = await response.json();
    console.log("[DAEMON] Join initialized on server", data);
    session = {
      id: data.sessionId,
      name: data.name,
      role: "guest",
      isConnected: false,
      userId: null,
      tempUserId: data.tempUserId,
      wsToken: data.wsToken,
      roomSecret: roomSecret || null
    };
    encryptionKey = await deriveKey(data.sessionId, roomSecret);
    console.log("[DAEMON] E2EE Cryptographic key derived");
    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);
    writeStateFile();
    res.json({ success: true, sessionId: data.sessionId });
  } catch (err) {
    console.error("[DAEMON] Failed to join session:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/session/approve", (req, res) => {
  const { tempUserId } = req.body;
  if (!tempUserId) {
    return res.status(400).json({ success: false, error: "tempUserId required" });
  }
  if (session.role !== "host") {
    return res.status(403).json({ success: false, error: "Only host can approve joins" });
  }
  const pending = pendingJoins.find((j) => j.tempUserId === tempUserId);
  if (!pending) {
    return res.status(404).json({ success: false, error: `No pending join request found for tempUserId: ${tempUserId}` });
  }
  console.log(`[DAEMON] Approving join request: ${tempUserId}`);
  wsConn?.send(JSON.stringify({
    type: "approve_join",
    payload: { sessionId: session.id, tempUserId }
  }));
  pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
  res.json({ success: true });
});
app.post("/session/reject", (req, res) => {
  const { tempUserId, reason } = req.body;
  if (!tempUserId) {
    return res.status(400).json({ success: false, error: "tempUserId required" });
  }
  if (session.role !== "host") {
    return res.status(403).json({ success: false, error: "Only host can reject joins" });
  }
  console.log(`[DAEMON] Rejecting join request: ${tempUserId}`);
  wsConn?.send(JSON.stringify({
    type: "reject_join",
    payload: { tempUserId, reason: reason || "Kicked by host CLI" }
  }));
  pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
  res.json({ success: true });
});
app.post("/session/kick", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: "userId required" });
  }
  if (session.role !== "host") {
    return res.status(403).json({ success: false, error: "Only host can kick users" });
  }
  console.log(`[DAEMON] Kicking user: ${userId}`);
  wsConn?.send(JSON.stringify({
    type: "kick",
    payload: { targetId: userId }
  }));
  res.json({ success: true });
});
app.post("/session/close", (req, res) => {
  console.log("[DAEMON] Closing active session \u2014 full teardown");
  sessionTerminated = true;
  try {
    console.log(`[DAEMON] close: role=${session.role} id=${session.id} wsState=${wsConn ? wsConn.readyState : "no-ws"}`);
    if (wsConn && wsConn.readyState === 1 && session.id) {
      if (session.role === "host") {
        wsConn.send(JSON.stringify({ type: "delete_session", payload: { sessionId: session.id } }));
        console.log("[DAEMON] close: sent delete_session");
      } else {
        wsConn.send(JSON.stringify({ type: "leave_session", payload: { sessionId: session.id, userId: session.userId } }));
        console.log("[DAEMON] close: sent leave_session");
      }
    }
  } catch (e) {
    console.error("[DAEMON] close: send failed", e?.message);
  }
  if (wsConn) {
    const _ws = wsConn;
    setTimeout(() => {
      try {
        _ws.close();
      } catch {
      }
    }, 700);
    wsConn = null;
  }
  wsUrl = null;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (wtClient) {
    try {
      wtClient.destroy();
    } catch {
    }
    wtClient = null;
  }
  activeTorrents.clear();
  session = { id: null, name: null, role: null, isConnected: false, userId: null };
  activeTransfers = [];
  chatHistory = [];
  pendingJoins = [];
  csrfToken = null;
  encryptionKey = null;
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        } catch {
        }
      }
    }
  } catch {
  }
  writeStateFile();
  res.json({ success: true });
});
app.post("/send", async (req, res) => {
  try {
    const { filePath, protocol } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: "filePath is required" });
    }
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    }
    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const targetProtocol = protocol === "webtorrent" || stat.size > 10 * 1024 * 1024 && protocol !== "websocket" ? "webtorrent" : "websocket";
    const newTx = {
      fileId,
      name: filename,
      size: stat.size,
      progress: 0,
      speedKBps: 0,
      etaSeconds: 0,
      protocol: targetProtocol,
      status: "pending",
      direction: "upload",
      filePath: absPath,
      bytesTransferred: 0,
      chunksCount: 0,
      totalChunks: 0,
      startTime: Date.now()
    };
    activeTransfers.push(newTx);
    writeStateFile();
    console.log(`[DAEMON] Offering file via ${targetProtocol}: ${filename} (${stat.size} bytes)`);
    wsConn?.send(JSON.stringify({
      type: "file_offer",
      payload: {
        fileId,
        filename,
        size: stat.size,
        mime: "application/octet-stream",
        transferType: targetProtocol,
        csrfToken
      }
    }));
    res.json({ success: true, fileId, protocol: targetProtocol });
  } catch (err) {
    console.error("[DAEMON] Send offer failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/receive", (req, res) => {
  const { fileId, saveDir } = req.body;
  if (!fileId) {
    return res.status(400).json({ success: false, error: "fileId is required" });
  }
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) {
    return res.status(404).json({ success: false, error: "No offer found for this fileId" });
  }
  tx.saveDir = saveDir ? path.resolve(saveDir) : process.cwd();
  tx.status = "downloading";
  tx.startTime = Date.now();
  console.log(`[DAEMON] Accepting file offer ${fileId}, saving to ${tx.saveDir}`);
  wsConn?.send(JSON.stringify({
    type: "file_accept",
    payload: { fileId }
  }));
  res.json({ success: true });
});
app.post("/chat/send", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: "message required" });
    }
    if (!session.id) {
      return res.status(409).json({ success: false, error: "No active session. Call /session/start first." });
    }
    if (!encryptionKey) {
      return res.status(409).json({ success: false, error: "Encryption key not ready. Session still initialising." });
    }
    if (!wsConn || wsConn.readyState !== 1) {
      return res.status(503).json({
        success: false,
        error: "Signaling connection not ready (WebSocket is connecting). Retry in 1\u20132 seconds.",
        retryAfterMs: 1500
      });
    }
    const encContent = await encrypt(message);
    wsConn.send(JSON.stringify({
      type: "chat",
      payload: { content: encContent, encrypted: true }
    }));
    const chatMsg = {
      messageId: uuidv4(),
      sender: "Me",
      content: message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    chatHistory.push(chatMsg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("/chat/history", (req, res) => {
  res.json(chatHistory);
});
app.get("/state", (req, res) => {
  const statePath = path.join(process.cwd(), ".srift-state.json");
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, "utf-8");
      res.type("application/json").send(raw);
    } else {
      res.json({ session: { id: null, isConnected: false }, activeTransfers: [], lastUpdated: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
async function registerPubshare(fileId, absPath, filename, size, mime, opts = {}, timeoutMs = 5e3) {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
    throw new Error("Signaling WebSocket not connected");
  }
  const maxDownloads = Math.max(0, Math.floor(opts.maxDownloads || 0));
  const expiresAt = opts.ttlMs && opts.ttlMs > 0 ? Date.now() + opts.ttlMs : null;
  const entry = {
    token: opts.preferToken || null,
    filePath: absPath,
    filename,
    size,
    mime,
    fileId,
    downloadUrl: null,
    maxDownloads,
    expiresAt,
    downloadCount: 0,
    createdAt: Date.now()
  };
  pubshares.set(fileId, entry);
  const ackP = new Promise((resolve, reject) => {
    pubshareRegResolvers.set(fileId, resolve);
    setTimeout(() => {
      if (pubshareRegResolvers.has(fileId)) {
        pubshareRegResolvers.delete(fileId);
        pubshares.delete(fileId);
        reject(new Error(
          "Signaler does not recognise pubshare_register \u2014 likely running an older server build. Until srift.app picks up the new release, the recipient must join the session in a browser."
        ));
      }
    }, timeoutMs);
  });
  wsConn.send(JSON.stringify({
    type: "pubshare_register",
    payload: {
      fileId,
      filename,
      size,
      mime,
      maxDownloads,
      expiresAt,
      preferToken: opts.preferToken || void 0
    }
  }));
  return ackP;
}
async function reregisterPubsharesAfterReconnect() {
  if (!pubshares.size) return;
  console.log(`[DAEMON] Re-registering ${pubshares.size} pubshare(s) after WS reconnect\u2026`);
  for (const entry of Array.from(pubshares.values())) {
    if (!entry.token) continue;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      continue;
    }
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      continue;
    }
    try {
      const remainingTtl = entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : 0;
      const remainingMax = entry.maxDownloads ? Math.max(1, entry.maxDownloads - entry.downloadCount) : 0;
      await registerPubshare(
        entry.fileId,
        entry.filePath,
        entry.filename,
        entry.size,
        entry.mime,
        { maxDownloads: remainingMax, ttlMs: remainingTtl, preferToken: entry.token }
      );
    } catch (e) {
      console.warn(`[DAEMON] Failed to re-register pubshare ${entry.fileId}: ${e?.message}`);
    }
  }
}
async function handlePubsharePull(payload) {
  const { requestId, token, start, end, isFullDownload } = payload || {};
  if (!requestId || !token) return;
  const entry = pubsharesByToken.get(token);
  if (!entry) {
    wsConn?.send(JSON.stringify({
      type: "pubshare_end",
      payload: { requestId, ok: false, error: "unknown token" }
    }));
    return;
  }
  const cancelFlag = { cancelled: false };
  activePulls.set(requestId, cancelFlag);
  const CHUNK = 64 * 1024;
  let pos = start;
  let seq = 0;
  let completedOk = false;
  const fd = fs.openSync(entry.filePath, "r");
  try {
    while (pos <= end) {
      if (cancelFlag.cancelled) break;
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        throw new Error("Signaling WebSocket disconnected mid-stream");
      }
      const len = Math.min(CHUNK, end - pos + 1);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      const dataB64 = buf.toString("base64");
      wsConn.send(JSON.stringify({
        type: "pubshare_chunk",
        payload: { requestId, seq, dataB64 }
      }));
      pos += len;
      seq++;
      if (wsConn.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (!cancelFlag.cancelled) {
      wsConn?.send(JSON.stringify({
        type: "pubshare_end",
        payload: { requestId, ok: true }
      }));
      completedOk = true;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
    }
    activePulls.delete(requestId);
  }
  if (completedOk && isFullDownload) {
    entry.downloadCount++;
    broadcastSSE("pubshare_download", {
      token: entry.token,
      fileId: entry.fileId,
      filename: entry.filename,
      downloadCount: entry.downloadCount,
      maxDownloads: entry.maxDownloads
    });
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      console.log(`[DAEMON] pubshare exhausted (max ${entry.maxDownloads} reached): ${entry.filename}`);
    }
  }
}
app.post("/quick-share", async (req, res) => {
  try {
    const { filePath, sessionName, maxDownloads, ttlMs } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: "filePath required" });
    if (!session.id) {
      const sName = sessionName || "AI-QuickShare";
      const createRes = await fetch(`${activeSignalerUrl}/create-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "AI-Agent", name: sName })
      });
      if (!createRes.ok) throw new Error(`Signaler returned ${createRes.status}`);
      const data = await createRes.json();
      session = {
        id: data.sessionId,
        name: data.name,
        role: "host",
        isConnected: false,
        userId: data.userId,
        wsToken: data.wsToken,
        roomSecret: null
      };
      encryptionKey = await deriveKey(data.sessionId);
      wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
      if (wsUrl) connectWebSocket(wsUrl);
      writeStateFile();
      await new Promise((r) => setTimeout(r, 800));
    }
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const targetProtocol = stat.size > 10 * 1024 * 1024 ? "webtorrent" : "websocket";
    activeTransfers.push({
      fileId,
      name: filename,
      size: stat.size,
      progress: 0,
      speedKBps: 0,
      etaSeconds: 0,
      protocol: targetProtocol,
      status: "pending",
      direction: "upload",
      filePath: absPath,
      bytesTransferred: 0,
      chunksCount: 0,
      totalChunks: 0,
      startTime: Date.now()
    });
    writeStateFile();
    wsConn?.send(JSON.stringify({
      type: "file_offer",
      payload: { fileId, filename, size: stat.size, mime: "application/octet-stream", transferType: targetProtocol, csrfToken }
    }));
    let downloadUrl = null;
    let expiresAt = null;
    let cappedMaxDownloads = 0;
    try {
      const entry = await registerPubshare(
        fileId,
        absPath,
        filename,
        stat.size,
        "application/octet-stream",
        {
          maxDownloads: typeof maxDownloads === "number" ? maxDownloads : 0,
          ttlMs: typeof ttlMs === "number" ? ttlMs : 0
        }
      );
      downloadUrl = entry.downloadUrl;
      expiresAt = entry.expiresAt;
      cappedMaxDownloads = entry.maxDownloads;
    } catch (e) {
      console.warn("[DAEMON] pubshare registration failed (link unavailable):", e?.message);
    }
    const publicBase = process.env.SRIFT_PUBLIC_BASE || "https://srift.app";
    res.json({
      success: true,
      sessionId: session.id,
      fileId,
      downloadUrl,
      // ← preferred (zero-install)
      shareUrl: downloadUrl || `${publicBase}/join-session?id=${session.id}`,
      // back-compat
      fileName: filename,
      fileSize: stat.size,
      maxDownloads: cappedMaxDownloads,
      // 0 = unlimited
      expiresAt
      // epoch ms or null
    });
  } catch (err) {
    console.error("[DAEMON] /quick-share failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/pubshare", async (req, res) => {
  try {
    const { filePath, maxDownloads, ttlMs } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: "filePath required" });
    if (!session.id || !session.isConnected) {
      return res.status(409).json({ success: false, error: "No active session \u2014 run `srift session start` or `srift quick-share` first" });
    }
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const entry = await registerPubshare(
      fileId,
      absPath,
      filename,
      stat.size,
      "application/octet-stream",
      {
        maxDownloads: typeof maxDownloads === "number" ? maxDownloads : 0,
        ttlMs: typeof ttlMs === "number" ? ttlMs : 0
      }
    );
    res.json({
      success: true,
      sessionId: session.id,
      fileId,
      token: entry.token,
      downloadUrl: entry.downloadUrl,
      fileName: filename,
      fileSize: stat.size,
      maxDownloads: entry.maxDownloads,
      expiresAt: entry.expiresAt
    });
  } catch (err) {
    console.error("[DAEMON] /pubshare failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("/pubshare/list", (_req, res) => {
  const now = Date.now();
  const items = Array.from(pubshares.values()).filter((e) => !e.expiresAt || e.expiresAt > now).map((e) => ({
    token: e.token,
    downloadUrl: e.downloadUrl,
    fileId: e.fileId,
    fileName: e.filename,
    fileSize: e.size,
    downloadCount: e.downloadCount,
    maxDownloads: e.maxDownloads,
    expiresAt: e.expiresAt,
    createdAt: e.createdAt
  }));
  res.json({ success: true, items });
});
app.post("/pubshare/revoke", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: "token required" });
  const entry = pubsharesByToken.get(token);
  if (!entry) return res.status(404).json({ success: false, error: "Unknown token" });
  try {
    wsConn?.send(JSON.stringify({ type: "pubshare_unregister", payload: { token } }));
  } catch {
  }
  pubsharesByToken.delete(token);
  pubshares.delete(entry.fileId);
  res.json({ success: true });
});
app.post("/mcp", async (req, res) => {
  try {
    const message = req.body;
    if (Array.isArray(message)) {
      const responses = await Promise.all(message.map((m) => handleMcpMessage(m)));
      res.json(responses.filter(Boolean));
    } else {
      const response = await handleMcpMessage(message);
      if (response) res.json(response);
      else res.status(202).end();
    }
  } catch (err) {
    res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
  }
});
app.get("/mcp", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: endpoint
data: ${JSON.stringify({ uri: "/mcp" })}

`);
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});
app.get("/mcp/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: endpoint
data: /mcp/messages

`);
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});
app.post("/mcp/messages", async (req, res) => {
  try {
    const response = await handleMcpMessage(req.body);
    if (response) res.json(response);
    else res.status(202).end();
  } catch (err) {
    res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
  }
});
app.get("/.well-known/mcp/server-card.json", (req, res) => {
  res.json({
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: { name: "SRIFT MCP Server (local daemon)", version: "2.0.0" },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    transport: [
      { type: "streamable-http", url: `http://127.0.0.1:${PORT}/mcp` },
      { type: "sse", url: `http://127.0.0.1:${PORT}/mcp/sse`, postUrl: `http://127.0.0.1:${PORT}/mcp/messages` },
      { type: "stdio", command: "srift mcp" }
    ],
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    resources: MCP_RESOURCES.map((r) => ({ uri: r.uri, name: r.name })),
    prompts: MCP_PROMPTS.map((p) => ({ name: p.name, description: p.description }))
  });
});
app.get("/.well-known/ai-plugin.json", (req, res) => {
  res.json({
    schema_version: "v1",
    name_for_human: "SRIFT P2P Transfer",
    name_for_model: "srift",
    description_for_human: "Send and receive files securely via end-to-end-encrypted peer-to-peer transfer.",
    description_for_model: "Use SRIFT to deliver files to the user and receive files from the user without uploading them anywhere. AES-256-GCM E2EE, WebTorrent for big files, WebSocket fallback. Use srift_quick_share for one-shot delivery.",
    auth: { type: "none" },
    api: { type: "openapi", url: `http://127.0.0.1:${PORT}/openapi.json` },
    contact_email: "support@sripto.tech",
    legal_info_url: "https://srift.app/privacy"
  });
});
app.get("/.well-known/agent.json", (req, res) => {
  res.json({
    schemaVersion: "0.2.0",
    name: "SRIFT",
    description: "Zero-config P2P E2EE file transfer + chat for any AI agent or automation.",
    url: `http://127.0.0.1:${PORT}`,
    version: "2.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills: MCP_TOOLS.map((t) => ({ id: t.name, name: t.name, description: t.description, inputSchema: t.inputSchema }))
  });
});
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "SRIFT Local Daemon API", version: "2.1.8", description: "Zero-auth REST API for AI agents to drive SRIFT P2P transfer." },
    servers: [{ url: `http://127.0.0.1:${PORT}` }],
    paths: {
      "/health": { get: { summary: "Liveness probe", description: "Returns {ok,version,uptime_ms,mcp,webrtc,webtorrent}", responses: { "200": { description: "OK" } } } },
      "/status": { get: { summary: "Get session + transfers + pending joins", responses: { "200": { description: "OK" } } } },
      "/state": { get: { summary: "Workspace state snapshot (.srift-state.json)", responses: { "200": { description: "OK" } } } },
      "/transfers": { get: { summary: "Live transfer list with speed and ETA. Optional ?fileId= to filter.", responses: { "200": { description: "OK" } } } },
      "/transfers/{fileId}": { get: { summary: "Per-transfer drill-down", parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { description: "Transfer not found" } } } },
      "/peers": { get: { summary: "Peer connection state, RTT, ICE type", responses: { "200": { description: "OK" } } } },
      "/metrics": { get: { summary: "Prometheus-format counters (no auth)", responses: { "200": { description: "text/plain Prometheus format" } } } },
      "/logs": { get: { summary: "NDJSON daemon log tail. ?lines=N (default 100)", responses: { "200": { description: "application/x-ndjson" } } } },
      "/reset": { post: { summary: "Wipe all state and flush encryption keys", responses: { "200": { description: "{ok:true}" } } } },
      "/session/start": { post: { summary: "Create new session (becomes host)", requestBody: { content: { "application/json": { schema: { type: "object", properties: { sessionName: { type: "string" }, roomSecret: { type: "string" } } } } } }, responses: { "200": { description: "{success:true,sessionId}" } } } },
      "/session/join": { post: { summary: "Join existing session", requestBody: { content: { "application/json": { schema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, username: { type: "string" }, roomSecret: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "Missing sessionId" }, "404": { description: "Session not found" } } } },
      "/session/approve": { post: { summary: "Host approves a pending join request", requestBody: { content: { "application/json": { schema: { type: "object", required: ["tempUserId"], properties: { tempUserId: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "tempUserId required" }, "403": { description: "Not host" }, "404": { description: "No such pending request" } } } },
      "/session/reject": { post: { summary: "Host rejects a pending join request", requestBody: { content: { "application/json": { schema: { type: "object", required: ["tempUserId"], properties: { tempUserId: { type: "string" }, reason: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "tempUserId required" }, "403": { description: "Not host" } } } },
      "/session/kick": { post: { summary: "Host kicks a peer", requestBody: { content: { "application/json": { schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "userId required" }, "403": { description: "Not host" } } } },
      "/session/close": { post: { summary: "Tear down the session and flush keys", responses: { "200": { description: "OK" } } } },
      "/send": { post: { summary: "Offer a file to peers (requires active session)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["filePath"], properties: { filePath: { type: "string" } } } } } }, responses: { "200": { description: "{success:true,fileId}" } } } },
      "/receive": { post: { summary: "Accept an incoming file offer", requestBody: { content: { "application/json": { schema: { type: "object", required: ["fileId"], properties: { fileId: { type: "string" }, saveDir: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "404": { description: "No offer for this fileId" } } } },
      "/quick-share": { post: { summary: "ONE-SHOT: create session if needed, register the file for public HTTPS download, and return a direct downloadUrl (https://srift.app/d/<token>) the recipient can curl/wget/browse with zero install.", requestBody: { content: { "application/json": { schema: { type: "object", required: ["filePath"], properties: { filePath: { type: "string", description: "Absolute path to file" }, sessionName: { type: "string" } } } } } }, responses: { "200": { description: "{success,sessionId,fileId,downloadUrl,shareUrl,fileName,fileSize}" } } } },
      "/chat/send": { post: { summary: "Send E2EE chat message", requestBody: { content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "message required" }, "409": { description: "No session" }, "503": { description: "WS not ready \u2014 retry in 1\u20132s" } } } },
      "/chat/history": { get: { summary: "Decrypted chat log", responses: { "200": { description: "Array of {messageId,sender,content,timestamp}" } } } },
      "/api/v1/monitor/events": { get: { summary: "SSE event stream: connection_state, join_request, file_offer, transfer_progress, chat_received", responses: { "200": { description: "text/event-stream" } } } },
      "/mcp": { post: { summary: "MCP JSON-RPC (Streamable HTTP, spec 2025-06-18)", responses: { "200": { description: "JSON-RPC response" } } }, get: { summary: "SSE stream for server\u2192client MCP notifications", responses: { "200": { description: "text/event-stream" } } } },
      "/mcp/sse": { get: { summary: "Legacy SSE MCP endpoint (older clients)", responses: { "200": { description: "text/event-stream" } } } },
      "/mcp/messages": { post: { summary: "Legacy SSE MCP message submission endpoint", responses: { "200": { description: "OK" } } } }
    }
  });
});
app.get("/transfers", (req, res) => {
  const fileId = req.query.fileId;
  const list = fileId ? activeTransfers.filter((t) => t.fileId === fileId) : activeTransfers;
  res.json(list.map((t) => ({
    fileId: t.fileId,
    name: t.name,
    size: t.size,
    progress: parseFloat(t.progress.toFixed(2)),
    speedKBps: parseFloat(t.speedKBps.toFixed(2)),
    etaSeconds: Math.ceil(t.etaSeconds),
    protocol: t.protocol,
    status: t.status,
    direction: t.direction,
    bytesTransferred: t.bytesTransferred
  })));
});
app.get("/transfers/:fileId", (req, res) => {
  const tx = activeTransfers.find((t) => t.fileId === req.params.fileId);
  if (!tx) return res.status(404).json({ error: "Transfer not found" });
  res.json(tx);
});
app.get("/peers", (req, res) => {
  if (!session.id) return res.json([]);
  const state = wsConn ? wsConn.readyState : 3;
  const stateNames = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
  const peer = {
    sessionId: session.id,
    userId: session.userId,
    role: session.role,
    connectionState: stateNames[state] || "UNKNOWN",
    transport: "websocket",
    rttMs: null,
    iceType: "relay",
    isConnected: session.isConnected
  };
  res.json(session.id ? [peer] : []);
});
app.get("/metrics", (req, res) => {
  const uptime = ((Date.now() - DAEMON_START_TIME) / 1e3).toFixed(0);
  const lines = [
    "# HELP srift_uptime_seconds Daemon uptime in seconds",
    "# TYPE srift_uptime_seconds gauge",
    `srift_uptime_seconds ${uptime}`,
    "# HELP srift_active_transfers Number of active file transfers",
    "# TYPE srift_active_transfers gauge",
    `srift_active_transfers ${activeTransfers.filter((t) => t.status === "uploading" || t.status === "downloading").length}`,
    "# HELP srift_total_transfers Total transfers (all statuses)",
    "# TYPE srift_total_transfers counter",
    `srift_total_transfers ${activeTransfers.length}`,
    "# HELP srift_chat_messages_total Total chat messages in history",
    "# TYPE srift_chat_messages_total counter",
    `srift_chat_messages_total ${chatHistory.length}`,
    "# HELP srift_session_active Whether a session is currently active (1 = yes)",
    "# TYPE srift_session_active gauge",
    `srift_session_active ${session.id ? 1 : 0}`,
    "# HELP srift_ws_connected Whether the WebSocket is connected (1 = yes)",
    "# TYPE srift_ws_connected gauge",
    `srift_ws_connected ${session.isConnected ? 1 : 0}`
  ];
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(lines.join("\n") + "\n");
});
app.get("/logs", (req, res) => {
  const lines = parseInt(req.query.lines || "100", 10);
  try {
    if (!fs.existsSync(logPath)) return res.json([]);
    const content = fs.readFileSync(logPath, "utf-8");
    const all = content.split("\n").filter(Boolean);
    const tail = all.slice(-Math.min(lines, all.length));
    res.set("Content-Type", "application/x-ndjson");
    res.send(tail.join("\n"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/reset", (req, res) => {
  console.log("[DAEMON] /reset: full wipe (memory + disk)");
  if (wsConn) {
    try {
      wsConn.close();
    } catch {
    }
    wsConn = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (wtClient) {
    try {
      wtClient.destroy();
    } catch {
    }
    wtClient = null;
  }
  activeTorrents.clear();
  activeUploads.clear();
  session = { id: null, name: null, role: null, isConnected: false, userId: null };
  activeTransfers = [];
  chatHistory = [];
  pendingJoins = [];
  csrfToken = null;
  encryptionKey = null;
  wsUrl = null;
  let cleanedChunks = 0;
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, f));
          cleanedChunks++;
        } catch {
        }
      }
    }
  } catch {
  }
  writeStateFile();
  res.json({ ok: true, message: "State wiped, keys flushed, temp chunks cleaned", cleanedChunks });
});
app.get("/api/v1/monitor/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.push(res);
  console.log(`[DAEMON] SSE Client connected. Active clients: ${sseClients.length}`);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
    console.log(`[DAEMON] SSE Client disconnected. Active clients: ${sseClients.length}`);
  });
});
app.post("/daemon/stop", (req, res) => {
  console.log("[DAEMON] Stop request received. Exiting daemon process gracefully...");
  res.json({ success: true });
  try {
    if (wsConn) {
      wsConn.close();
      wsConn = null;
    }
  } catch {
  }
  try {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  } catch {
  }
  try {
    if (wtClient) {
      wtClient.destroy();
      wtClient = null;
    }
  } catch {
  }
  try {
    activeTorrents.clear();
    activeUploads.clear();
  } catch {
  }
  try {
    session = { id: null, name: null, role: null, isConnected: false, userId: null };
    activeTransfers = [];
    chatHistory = [];
    pendingJoins = [];
    encryptionKey = null;
    wsUrl = null;
    writeStateFile();
  } catch {
  }
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        } catch {
        }
      }
    }
  } catch {
  }
  setTimeout(() => {
    process.exit(0);
  }, 500);
});
app.listen(PORT, "127.0.0.1", async () => {
  await selectSignalerUrl();
  console.log(`[DAEMON] Background daemon listening on http://127.0.0.1:${PORT}`);
  writeStateFile();
});
