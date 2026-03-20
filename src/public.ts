import { TZDate } from "@date-fns/tz";
import { addMonths, endOfMonth, fromUnixTime } from "date-fns";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ApplyGlobalResponse } from "hono/client";
import { hc } from "hono/client";
import { match } from "ts-pattern";
import { coupons } from "./db/schema";
import {
  type Variables,
  COUPON_EXPIRE_MONTHS,
  MESSAGES,
  payloadMiddleware,
  getSurveyStatus,
  getCouponStatus,
} from "./utils";

export const app = new Hono<{ Variables: Variables }>().basePath("public");
export const typedApp = app
  .get("/status", payloadMiddleware, async (c) => {
    const payload = c.get("payload");

    const [coupon] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!coupon) {
      return c.json(getSurveyStatus(payload.surveyExp), 200);
    }
    return c.json(getCouponStatus(coupon), 200);
  })
  .post("/answer", payloadMiddleware, async (c) => {
    const payload = c.get("payload");

    if (fromUnixTime(payload.surveyExp) < new Date()) {
      return c.json({ message: MESSAGES.SURVEY_EXPIRED }, 400);
    }

    const couponExp = endOfMonth(addMonths(TZDate.tz("Asia/Tokyo"), COUPON_EXPIRE_MONTHS));
    const [inserted] = await c
      .get("db")
      .insert(coupons)
      .values({ id: payload.sub, exp: couponExp })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return c.json(inserted, 201);
    }

    // 発行済みの場合
    const [existing] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!existing) {
      return c.json({ message: MESSAGES.UNEXPECTED_ERROR }, 500);
    }
    return match(getCouponStatus(existing))
      .with({ status: "coupon expired" }, () => c.json({ message: MESSAGES.UNEXPECTED_ERROR }, 500))
      .with({ status: "used" }, () => c.json({ message: MESSAGES.COUPON_USED }, 400))
      .with({ status: "active" }, () => c.json(existing, 200))
      .exhaustive();
  });

export type PublicAppType = ApplyGlobalResponse<
  typeof typedApp,
  {
    400: { json: { message: string } };
    401: { json: { message: string } };
  }
>;

export const hcWithType = (...args: Parameters<typeof hc>) => hc<PublicAppType>(...args);
