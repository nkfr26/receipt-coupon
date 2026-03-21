import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";

import { env } from "../env";
import { app as adminApp } from "./admin";
import { app as publicApp } from "./public";
import type { Variables } from "./utils";

export function createApp(db: ReturnType<typeof drizzle>) {
  return new Hono<{ Variables: Variables }>()
    .use(async (c, next) => {
      c.set("db", db);
      await next();
    })
    .route("", adminApp)
    .route("", publicApp);
}

export default createApp(drizzle(env.DB_FILE_NAME));
