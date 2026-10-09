import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, serve } from "./ws.js";

type Ping = { n: bigint };
type Pong = { doubled: bigint };

test("request and reply keep bigint values and pushes reach the client", async () => {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const server = serve<Ping, Pong, { tick: number }>(port, async (request) => {
    if (request.n < 0n) throw new Error("negative");
    return { doubled: request.n * 2n };
  });
  const peer = connect<Ping, Pong, { tick: number }>(`ws://127.0.0.1:${port}`);
  const pushed = new Promise<number>((resolve) => peer.onPush((message) => resolve(message.tick)));

  assert.deepEqual(await peer.request({ n: 21n }), { doubled: 42n });
  await assert.rejects(peer.request({ n: -1n }), /negative/);
  server.broadcast({ tick: 7 });
  assert.equal(await pushed, 7);

  peer.close();
  await server.close();
});
