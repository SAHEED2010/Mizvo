import { buildApp } from "./app.js";

const app = buildApp();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
