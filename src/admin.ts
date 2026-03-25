import { TZDate } from "@date-fns/tz";
import { addDays, endOfDay } from "date-fns";
import { and, eq, gte, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { ApplyGlobalResponse } from "hono/client";
// import { hc } from "hono/client";
import { sign } from "hono/jwt";
import { nanoid } from "nanoid";
import { match } from "ts-pattern";

import { env } from "../env";
import { coupons } from "./db/schema";
import type { Payload, Variables } from "./utils";
import {
  getCouponStatus,
  MESSAGES,
  payloadMiddleware,
  SURVEY_EXPIRE_DAYS,
  TIMEZONE,
} from "./utils";

export const app = new Hono<{ Variables: Variables }>()
  .basePath("admin")
  .use(
    basicAuth({
      username: env.BA_USERNAME,
      password: env.BA_PASSWORD,
      invalidUserMessage: { message: MESSAGES.UNAUTHORIZED },
    }),
  );

const typedApp = app
  .post("/issue", async (c) => {
    const surveyExp = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS)).getTime();
    return c.json(
      {
        token: await sign({ sub: nanoid(), surveyExp } satisfies Payload, env.SECRET),
        surveyExp,
      },
      201,
    );
  })
  .put("/use", payloadMiddleware, async (c) => {
    const payload = c.get("payload");

    const now = new Date();
    const [updated] = await c
      .get("db")
      .update(coupons)
      .set({ usedAt: now })
      .where(and(eq(coupons.id, payload.sub), gte(coupons.exp, now), isNull(coupons.usedAt)))
      .returning();

    if (updated) {
      return c.json(updated, 200);
    }

    // 使用処理に失敗した場合
    const [existing] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!existing) {
      return c.json({ message: MESSAGES.COUPON_NOT_FOUND }, 404);
    }
    return match(getCouponStatus(existing))
      .with({ status: "coupon expired" }, () => c.json({ message: MESSAGES.COUPON_EXPIRED }, 400))
      .with({ status: "used" }, () => c.json({ message: MESSAGES.COUPON_USED }, 400))
      .with({ status: "active" }, () => c.json({ message: MESSAGES.UNEXPECTED_ERROR }, 500))
      .exhaustive();
  });

export type AdminAppType = ApplyGlobalResponse<
  typeof typedApp,
  {
    400: { json: { message: string } };
    401: { json: { message: string } };
  }
>;

// export const hcWithType = (...args: Parameters<typeof hc>) => hc<AdminAppType>(...args);
