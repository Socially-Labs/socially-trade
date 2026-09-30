import { createPool } from "@socially/db";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const pool = process.env.DATABASE_URL ? createPool() : null;
const app = createApp(pool);
await app.listen({
  port,
  host: process.env.HOST ?? (process.env.DEV_AUTH_TOKEN ? "127.0.0.1" : "0.0.0.0"),
});
