import { fromUnixTime, isPast } from "date-fns";
import { drizzle } from "drizzle-orm/libsql";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import { env } from "../env";
import * as v from "valibot";
import { coupons } from "./db/schema";

export const TIMEZONE = "Asia/Tokyo";
export const SURVEY_EXPIRE_DAYS = 7;
export const COUPON_EXPIRE_MONTHS = 1;

export const MESSAGES = {
  TOKEN_INVALID: "このURLは無効です",
  SURVEY_EXPIRED: "アンケートの回答期限が過ぎています",
  COUPON_NOT_FOUND: "このクーポンは無効です",
  COUPON_USED: "このクーポンは既に使用されています",
  COUPON_EXPIRED: "クーポンの有効期限が切れています",
  UNEXPECTED_ERROR: "予期せぬエラーが発生しました",
} as const;

const PayloadSchema = v.object({
  sub: v.pipe(v.string(), v.nanoid()),
  surveyExp: v.pipe(v.number(), v.integer()),
});
export type Payload = v.InferOutput<typeof PayloadSchema>;

export type Variables = {
  db: ReturnType<typeof drizzle>;
  payload: Payload;
};

export async function getPayload(token: string) {
  try {
    return { payload: v.parse(PayloadSchema, await verify(token, env.SECRET, "HS256")) };
  } catch {
    return { message: MESSAGES.TOKEN_INVALID };
  }
}

export function getSurveyStatus(surveyExp: number) {
  if (isPast(fromUnixTime(surveyExp))) {
    return { status: "survey expired" } as const;
  }
  return { status: "unanswered", surveyExp } as const;
}

export function getCouponStatus(coupon: typeof coupons.$inferSelect) {
  if (isPast(coupon.exp)) {
    return { status: "coupon expired" } as const;
  }
  if (coupon.usedAt) {
    return { status: "used" } as const;
  }
  return { status: "active", ...coupon } as const;
}

export const payloadMiddleware = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ message: MESSAGES.TOKEN_INVALID }, 400);
  }
  const { payload, message } = await getPayload(token);
  if (!payload) {
    return c.json({ message }, 401);
  }
  c.set("payload", payload);
  await next();
});
