import { TZDate } from "@date-fns/tz";
import { vValidator } from "@hono/valibot-validator";
import {
  addDays,
  addMonths,
  endOfDay,
  endOfMonth,
  fromUnixTime,
  getUnixTime,
  isPast,
} from "date-fns";
import { and, eq, gte, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { sign, verify } from "hono/jwt";
import { nanoid } from "nanoid";
import { match } from "ts-pattern";
import * as v from "valibot";
import { coupons } from "./db/schema";
import { env } from "../env";

export const TIMEZONE = "Asia/Tokyo";
export const SURVEY_EXPIRE_DAYS = 7;
export const COUPON_EXPIRE_MONTHS = 1;
const MESSAGES = {
  TOKEN_INVALID: "このURLは無効です",
  SURVEY_EXPIRED: "アンケートの回答期限が過ぎています",
  COUPON_NOT_FOUND: "このクーポンは無効です",
  COUPON_USED: "このクーポンは既に使用されています",
  COUPON_EXPIRED: "クーポンの有効期限が切れています",
  UNEXPECTED_ERROR: "予期せぬエラーが発生しました",
} as const;

const tokenQueryValidator = vValidator("query", v.object({ token: v.string() }), (result, c) => {
  if (!result.success) {
    return c.json({ message: MESSAGES.TOKEN_INVALID }, 400);
  }
});

const PayloadSchema = v.object({
  sub: v.pipe(v.string(), v.nanoid()),
  surveyExp: v.pipe(v.number(), v.integer()),
});
type Payload = v.InferOutput<typeof PayloadSchema>;

async function getPayload(token: string) {
  try {
    return { payload: v.parse(PayloadSchema, await verify(token, env.SECRET, "HS256")) };
  } catch {
    return { message: MESSAGES.TOKEN_INVALID };
  }
}

function getSurveyStatus(surveyExp: number) {
  if (isPast(fromUnixTime(surveyExp))) {
    return { status: "survey expired" } as const;
  }
  return { status: "unanswered", surveyExp } as const;
}

function getCouponStatus(coupon: typeof coupons.$inferSelect) {
  if (isPast(coupon.exp)) {
    return { status: "coupon expired" } as const;
  }
  if (coupon.usedAt) {
    return { status: "used" } as const;
  }
  return { status: "active", ...coupon } as const;
}

type Variables = {
  db: ReturnType<typeof drizzle>;
};

const adminApp = new Hono<{ Variables: Variables }>()
  .use(basicAuth({ username: env.USERNAME, password: env.PASSWORD }))
  .post("/issue", async (c) => {
    const surveyExp = getUnixTime(endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS)));
    return c.json({
      token: await sign({ sub: nanoid(), surveyExp } satisfies Payload, env.SECRET),
      surveyExp,
    });
  })
  .put("/use", tokenQueryValidator, async (c) => {
    const { token } = c.req.valid("query");
    const { payload, message } = await getPayload(token);
    if (!payload) {
      return c.json({ message }, 401);
    }

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

const publicApp = new Hono<{ Variables: Variables }>()
  .get("/status", tokenQueryValidator, async (c) => {
    const { token } = c.req.valid("query");
    const { payload, message } = await getPayload(token);
    if (!payload) {
      return c.json({ message }, 401);
    }

    const [coupon] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!coupon) {
      return c.json(getSurveyStatus(payload.surveyExp));
    }
    return c.json(getCouponStatus(coupon));
  })
  .post("/answer", tokenQueryValidator, async (c) => {
    const { token } = c.req.valid("query");
    const { payload, message } = await getPayload(token);
    if (!payload) {
      return c.json({ message }, 401);
    }

    if (isPast(fromUnixTime(payload.surveyExp))) {
      return c.json({ message: MESSAGES.SURVEY_EXPIRED }, 400);
    }

    const couponExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
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
      .with({ status: "coupon expired" }, () => c.json({ message: MESSAGES.COUPON_EXPIRED }, 400))
      .with({ status: "used" }, () => c.json({ message: MESSAGES.COUPON_USED }, 400))
      .with({ status: "active" }, () => c.json(existing, 200))
      .exhaustive();
  });

const app = new Hono<{ Variables: Variables }>();

const routes = app
  .basePath("/api")
  .use(async (c, next) => {
    c.set("db", drizzle(env.DB_FILE_NAME));
    await next();
  })
  .route("/admin", adminApp)
  .route("/", publicApp);

export default app;
export type AppType = typeof routes;
