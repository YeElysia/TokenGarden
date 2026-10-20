// Exercise the production Postgres.js serializer against PGlite's PostgreSQL wire
// protocol. Direct db.query adapters do not reproduce driver parameter encoding.
import { createServer } from "node:net";
import { once } from "node:events";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
const message = (type, body) => {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
export async function postgresWire() {
  const db = new PGlite();
  await db.waitReady;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Buffer.alloc(0),
      started = false,
      chain = Promise.resolve();
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!started) {
        if (pending.length < 4 || pending.length < pending.readInt32BE())
          return;
        pending = pending.subarray(pending.readInt32BE());
        started = true;
        socket.write(
          Buffer.concat([
            message("R", Buffer.alloc(4)),
            message("S", Buffer.from("server_version\x0017.0\x00")),
            message("S", Buffer.from("client_encoding\x00UTF8\x00")),
            message("K", Buffer.alloc(8)),
            message("Z", Buffer.from("I")),
          ]),
        );
      }
      while (
        pending.length >= 5 &&
        pending.length >= pending.readInt32BE(1) + 1
      ) {
        const size = pending.readInt32BE(1) + 1,
          frame = Buffer.from(pending.subarray(0, size));
        pending = pending.subarray(size);
        if (frame[0] === 88) {
          socket.end();
          continue;
        }
        chain = chain
          .then(async () => {
            const out = await db.execProtocolRaw(frame, { syncToFs: false });
            if (out.length && !socket.destroyed) socket.write(out);
          })
          .catch(() => socket.destroy());
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sql = postgres({
    host: "127.0.0.1",
    port: server.address().port,
    user: "postgres",
    database: "postgres",
    ssl: false,
    prepare: false,
    max: 1,
    fetch_types: false,
    connect_timeout: 3,
  });
  return {
    db,
    sql,
    async close() {
      await sql.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}
