import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createAcceptValue(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), body]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
}

function encodeJsonMessage(event, payload) {
  return encodeFrame(
    0x1,
    Buffer.from(
      JSON.stringify({
        event,
        payload,
        at: new Date().toISOString(),
      }),
      'utf8',
    ),
  );
}

function decodeFrames(buffer, options = {}) {
  const frames = [];
  let offset = 0;
  const maxFrameBytes = Math.max(Number(options.maxFrameBytes) || 1024 * 1024, 1);

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;

    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const value = buffer.readBigUInt64BE(offset + 2);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket frame too large');
      }
      payloadLength = Number(value);
      headerLength = 10;
    }

    if (payloadLength > maxFrameBytes) {
      throw new Error(`WebSocket frame too large: ${payloadLength} bytes`);
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) {
      break;
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const decoded = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        decoded[i] = payload[i] ^ mask[i % 4];
      }
      payload = decoded;
    }

    frames.push({ opcode, payload });
    offset += frameLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

export { createAcceptValue, encodeFrame, decodeFrames };

export class LiveUpdatesHub {
  constructor(options = {}) {
    this.clients = new Set();
    this.maxFrameBytes = Math.max(Number(options.maxFrameBytes) || 1024 * 1024, 1);
    this.maxBufferedBytes = Math.max(Number(options.maxBufferedBytes) || 2 * 1024 * 1024, this.maxFrameBytes);
    this.maxWritableBytes = Math.max(Number(options.maxWritableBytes) || 1024 * 1024, 1);
    this._pingTimer = null;
    this._startPingLoop();
  }

  _startPingLoop() {
    this._pingTimer = setInterval(() => {
      const now = Date.now();
      for (const client of [...this.clients]) {
        // 超过 90s 未收到 pong，断开连接
        if (client.lastPongAt && now - client.lastPongAt > 90_000) {
          try {
            client.socket.destroy();
          } catch {
            // ignore
          }
          this.clients.delete(client);
          continue;
        }

        try {
          client.socket.write(encodeFrame(0x9)); // ping
        } catch {
          try {
            client.socket.destroy();
          } catch {
            // ignore
          }
          this.clients.delete(client);
        }
      }
    }, 30_000);
  }

  destroy() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }

    for (const client of this.clients) {
      try {
        client.socket.destroy();
      } catch {
        // ignore
      }
    }

    this.clients.clear();
  }

  handleUpgrade(request, socket, head = Buffer.alloc(0)) {
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    const connection = String(request.headers.connection ?? '').toLowerCase();
    const key = request.headers['sec-websocket-key'];

    if (upgrade !== 'websocket' || !connection.includes('upgrade') || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return false;
    }

    const acceptValue = createAcceptValue(key);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '\r\n',
      ].join('\r\n'),
    );

    const client = {
      socket,
      buffer: Buffer.alloc(0),
      lastPongAt: Date.now(),
    };
    this.clients.add(client);

    const closeClient = () => {
      this.clients.delete(client);
    };

    socket.on('close', closeClient);
    socket.on('end', closeClient);
    socket.on('error', closeClient);

    socket.on('data', (chunk) => {
      try {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        if (client.buffer.length > this.maxBufferedBytes) {
          throw new Error('WebSocket connection buffer limit exceeded');
        }
        const { frames, remaining } = decodeFrames(client.buffer, {
          maxFrameBytes: this.maxFrameBytes,
        });
        client.buffer = remaining;

        for (const frame of frames) {
          if (frame.opcode === 0x8) {
            socket.write(encodeFrame(0x8, frame.payload));
            socket.end();
            return;
          }

          if (frame.opcode === 0x9) {
            socket.write(encodeFrame(0xA, frame.payload));
          }

          // pong 帧 — 更新最后活跃时间
          if (frame.opcode === 0xA) {
            client.lastPongAt = Date.now();
          }
        }
      } catch {
        socket.destroy();
      }
    });

    if (head.length > 0) {
      socket.emit('data', head);
    }

    this.sendToClient(client, 'connected', {
      clients: this.clients.size,
    });

    return true;
  }

  sendToClient(client, event, payload) {
    try {
      const frame = encodeJsonMessage(event, payload);
      if (frame.length > this.maxFrameBytes) {
        throw new Error('Outgoing WebSocket frame limit exceeded');
      }
      const accepted = client.socket.write(frame);
      if (!accepted && client.socket.writableLength > this.maxWritableBytes) {
        throw new Error('Slow WebSocket consumer');
      }
    } catch {
      try {
        client.socket.destroy();
      } catch {
        // ignore socket close errors
      }
      this.clients.delete(client);
    }
  }

  broadcast(event, payload) {
    for (const client of [...this.clients]) {
      this.sendToClient(client, event, payload);
    }
  }

  getClientCount() {
    return this.clients.size;
  }
}
