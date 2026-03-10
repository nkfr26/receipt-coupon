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
import { JwtTokenExpired } from "hono/utils/jwt/types";
import { nanoid } from "nanoid";
import { match } from "ts-pattern";
import * as v from "valibot";
import { coupons } from "./db/schema";
import { env } from "../env";

const TIMEZONE = "Asia/Tokyo";
const SURVEY_EXPIRE_DAYS = 7;
const COUPON_EXPIRE_MONTHS = 1;

const tokenQueryValidator = vValidator("query", v.object({ token: v.string() }));

const PayloadSchema = v.object({
  sub: v.pipe(v.string(), v.nanoid()),
  exp: v.pipe(v.number(), v.integer()),
  surveyExp: v.pipe(v.number(), v.integer()),
});
type Payload = v.InferOutput<typeof PayloadSchema>;

async function getPayload(token: string) {
  try {
    return { payload: v.parse(PayloadSchema, await verify(token, env.SECRET, "HS256")) };
  } catch (e) {
    if (e instanceof JwtTokenExpired) {
      return { message: "クーポンの有効期限が切れています" };
    }
    return { message: "無効なトークンです" };
  }
}

function getSurveyStatus(surveyExp: number) {
  if (isPast(fromUnixTime(surveyExp))) {
    return { status: "survey expired" } as const;
  }
  return { status: "unanswered", surveyExp } as const;
}

function getCouponStatus(coupon: typeof coupons.$inferSelect) {
  if (coupon.usedAt) return { status: "used" } as const;
  return { status: "active", ...coupon } as const;
}

const db = drizzle(env.DB_FILE_NAME);

type Variables = {
  db: typeof db;
};

const adminApp = new Hono<{ Variables: Variables }>()
  .use(basicAuth({ username: env.USERNAME, password: env.PASSWORD }))
  .post("/issue", async (c) => {
    const now = TZDate.tz(TIMEZONE);
    const surveyExp = getUnixTime(endOfDay(addDays(now, SURVEY_EXPIRE_DAYS)));
    const couponExp = getUnixTime(endOfMonth(addMonths(now, COUPON_EXPIRE_MONTHS)));
    return c.json({
      token: await sign({ sub: nanoid(), exp: couponExp, surveyExp } satisfies Payload, env.SECRET),
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
      .where(and(eq(coupons.id, payload.sub), isNull(coupons.usedAt), gte(coupons.exp, now)))
      .returning();

    if (updated) {
      return c.json(updated);
    }

    const [existing] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!existing) {
      return c.json({ message: "このクーポンは無効です" }, 404);
    }
    return match(getCouponStatus(existing))
      .with({ status: "used" }, () =>
        c.json({ message: "このクーポンは既に使用されています" }, 400),
      )
      .with({ status: "active" }, () => c.json({ message: "予期せぬエラーが発生しました" }, 500))
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
      return c.json({ message: "アンケートの回答期限が過ぎています" }, 400);
    }

    const [inserted] = await c
      .get("db")
      .insert(coupons)
      .values({ id: payload.sub, exp: fromUnixTime(payload.exp) })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return c.json(inserted, 201);
    }

    const [existing] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!existing) {
      return c.json({ message: "予期せぬエラーが発生しました" }, 500);
    }
    return match(getCouponStatus(existing))
      .with({ status: "used" }, () =>
        c.json({ message: "このクーポンは既に使用されています" }, 400),
      )
      .with({ status: "active" }, () => c.json(existing))
      .exhaustive();
  });

const app = new Hono<{ Variables: Variables }>();

const routes = app
  .basePath("/api")
  .use(async (c, next) => {
    c.set("db", db);
    await next();
  })
  .route("/admin", adminApp)
  .route("/", publicApp);

export default app;
export type AppType = typeof routes;
