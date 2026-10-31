import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { AppModule } from "./app";
import { settings, isAllowedOrigin } from "./config";
import { RedisSocketAdapter } from "./shared/redis-adapter";
async function main() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 1024 * 1024,
      trustProxy: process.env.TRUST_PROXY === "true",
    }),
  );
  await app.register(cookie as any);
  await app.register(multipart as any, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  if (process.env.REDIS_URL) {
    const adapter = new RedisSocketAdapter(app);
    await adapter.connect(process.env.REDIS_URL);
    app.useWebSocketAdapter(adapter);
  }
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed"), false);
      }
    },
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(settings.port, "0.0.0.0");
  console.log(`WMS API listening on port ${settings.port}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
