import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * Minimal WebSocket server (RFC 6455) built on Node's `net.Socket`.
 *
 * Why hand-rolled? To keep `agent-demo` zero-dependency (like its sibling
 * `mcp-server-demo`), we implement just enough of the protocol: the HTTP
 * upgrade handshake, frame decode (including masking from clients), and
 * frame encode for text messages. This is sufficient for JSON-RPC traffic.
 */

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WebSocketConn {
  socket: Duplex;
  send: (data: string) => void;
  close: () => void;
}

export type WebSocketHandler = (conn: WebSocketConn) => {
  onMessage: (data: string) => void;
  onClose?: () => void;
};

export function isUpgradeRequest(req: { method?: string; headers: Record<string, string | string[] | undefined> }): boolean {
  return (
    req.method === "GET" &&
    (req.headers["upgrade"] ?? "").toString().toLowerCase().includes("websocket") &&
    !!req.headers["sec-websocket-key"]
  );
}

/** Complete the WebSocket handshake on a raw socket from an IncomingMessage. */
export function upgrade(
  socket: Duplex,
  headers: Record<string, string | string[] | undefined>,
  handler: WebSocketHandler,
): void {
  const key = headers["sec-websocket-key"];
  if (!key || Array.isArray(key)) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let handlerCtx: ReturnType<WebSocketHandler> | null = null;
  const conn: WebSocketConn = {
    socket,
    send: (data: string) => socket.write(encodeTextFrame(data)),
    close: () => {
      // Send a close frame (opcode 0x8) then end.
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
    },
  };
  handlerCtx = handler(conn);

  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Drain as many complete frames as available.
    while (buffer.length >= 2) {
      const parsed = parseFrame(buffer);
      if (!parsed) break; // need more bytes
      buffer = buffer.subarray(parsed.consumed);

      if (parsed.opcode === 0x8) {
        // close
        handlerCtx?.onClose?.();
        socket.end();
        return;
      }
      if (parsed.opcode === 0x9) {
        // ping → pong
        socket.write(encodeFrame(0xa, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0xa) continue; // pong, ignore
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2 || parsed.opcode === 0x0) {
        // text / binary / continuation — we only use text for JSON-RPC.
        const text = Buffer.from(parsed.payload).toString("utf8");
        handlerCtx?.onMessage(text);
      }
    }
  });

  socket.on("close", () => handlerCtx?.onClose?.());
  socket.on("error", () => handlerCtx?.onClose?.());
}

interface ParsedFrame {
  opcode: number;
  payload: Uint8Array;
  consumed: number;
}

function parseFrame(buf: Buffer): ParsedFrame | null {
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    // Only safe for lengths < 2^32; fine for our payloads.
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 0x100000000 + lo;
    offset += 8;
  }

  let mask: Uint8Array = Buffer.alloc(0);
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  let payload: Uint8Array = buf.subarray(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
    payload = unmasked;
  }

  return { opcode, payload, consumed: offset + len };
}

/** Encode a text frame (server→client, unmasked). */
function encodeTextFrame(data: string): Uint8Array {
  return encodeFrame(0x1, Buffer.from(data, "utf8"));
}

function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Random masking key helper (clients must mask; servers don't, but kept for completeness). */
export function randomMask(): Uint8Array {
  return randomBytes(4);
}
