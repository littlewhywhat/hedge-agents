import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Handler, Peer, Server } from "./interface.js";

type Frame =
  | { kind: "request"; id: string; body: unknown }
  | { kind: "reply"; id: string; body: unknown }
  | { kind: "error"; id: string; error: string }
  | { kind: "push"; body: unknown };

const RECONNECT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;

const encode = (frame: Frame): string => {
  return JSON.stringify(frame, (_key, value) => (typeof value === "bigint" ? { $big: value.toString() } : value));
};

const decode = (text: string): Frame => {
  return JSON.parse(text, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$big === "string") {
      return BigInt(value.$big);
    }
    return value;
  }) as Frame;
};

export const serve = <Req, Res, Push>(port: number, handler: Handler<Req, Res>): Server<Push> => {
  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const frame = decode(data.toString());
      if (frame.kind !== "request") return;
      try {
        const body = await handler(frame.body as Req);
        if (socket.readyState === WebSocket.OPEN) socket.send(encode({ kind: "reply", id: frame.id, body }));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (socket.readyState === WebSocket.OPEN) socket.send(encode({ kind: "error", id: frame.id, error: text }));
      }
    });
  });

  http.listen(port);

  return {
    broadcast: (message) => {
      const text = encode({ kind: "push", body: message });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(text);
      }
    },
    close: () =>
      new Promise((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
};

export const connect = <Req, Res, Push>(url: string): Peer<Req, Res, Push> => {
  const pending = new Map<string, { resolve: (value: Res) => void; reject: (error: Error) => void }>();
  const listeners: ((message: Push) => void)[] = [];
  const waiting: (() => void)[] = [];
  let socket: WebSocket | null = null;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    const next = new WebSocket(url);
    next.on("open", () => {
      socket = next;
      for (const wake of waiting.splice(0)) wake();
    });
    next.on("message", (data) => {
      const frame = decode(data.toString());
      if (frame.kind === "push") {
        for (const listener of listeners) listener(frame.body as Push);
        return;
      }
      if (frame.kind !== "reply" && frame.kind !== "error") return;
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.kind === "reply") entry.resolve(frame.body as Res);
      else entry.reject(new Error(frame.error));
    });
    next.on("close", () => {
      if (socket === next) socket = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new Error(`connection to ${url} closed`));
      }
      setTimeout(open, RECONNECT_MS);
    });
    next.on("error", () => {});
  };

  const ready = (timeoutMs: number): Promise<WebSocket> => {
    if (socket) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${url} not reachable`)), timeoutMs);
      waiting.push(() => {
        clearTimeout(timer);
        if (socket) resolve(socket);
        else reject(new Error(`${url} not reachable`));
      });
    });
  };

  open();

  return {
    request: async (message, timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const live = await ready(Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
      const id = randomUUID();
      return new Promise<Res>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${url} did not answer in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        live.send(encode({ kind: "request", id, body: message }));
      });
    },
    onPush: (listener) => {
      listeners.push(listener);
    },
    connected: () => socket !== null,
    close: () => {
      closed = true;
      socket?.close();
    },
  };
};
