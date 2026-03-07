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
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { sign, verify } from "hono/jwt";
import { JwtTokenExpired } from "hono/utils/jwt/types";
import { nanoid } from "nanoid";
import * as v from "valibot";
import { db } from "./db";
import { coupons } from "./db/schema";
import { env } from "../env";

const TIMEZONE = "Asia/Tokyo";

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

type Variables = {
  db: typeof db;
};

const adminApp = new Hono<{ Variables: Variables }>()
  .use(basicAuth({ username: env.USERNAME, password: env.PASSWORD }))
  .post("/issue", async (c) => {
    const now = TZDate.tz(TIMEZONE);
    const surveyExp = getUnixTime(endOfDay(addDays(now, 7)));
    const couponExp = getUnixTime(endOfMonth(addMonths(now, 1)));
    return c.json({
      token: await sign({ sub: nanoid(), exp: couponExp, surveyExp } satisfies Payload, env.SECRET),
      surveyExp,
    });
  })
  .put("/use", vValidator("query", v.object({ token: v.string() })), async (c) => {
    const { token } = c.req.valid("query");
    const { payload, message } = await getPayload(token);
    if (!payload) {
      return c.json({ message }, 401);
    }

    const now = new Date();
    const [coupon] = await c
      .get("db")
      .update(coupons)
      .set({ usedAt: now })
      .where(and(eq(coupons.id, payload.sub), isNull(coupons.usedAt), gte(coupons.exp, now)))
      .returning();

    if (!coupon) {
      return c.json({ message: "このクーポンは無効、または使用済みです" }, 400);
    }
    return c.body(null, 204);
  });

const publicApp = new Hono<{ Variables: Variables }>()
  .get("/status", vValidator("query", v.object({ token: v.string() })), async (c) => {
    const { token } = c.req.valid("query");
    const { payload, message } = await getPayload(token);
    if (!payload) {
      return c.json({ message }, 401);
    }

    const [coupon] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!coupon) {
      if (isPast(fromUnixTime(payload.surveyExp))) {
        return c.json({ status: "survey expired" as const });
      }
      return c.json({ status: "unanswered" as const, surveyExp: payload.surveyExp });
    }
    if (coupon.usedAt) {
      return c.json({ status: "used" as const });
    }
    return c.json({ status: "active" as const, id: coupon.id, exp: coupon.exp });
  })
  .post("/answer", vValidator("query", v.object({ token: v.string() })), async (c) => {
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
      return c.json({ id: inserted.id, exp: inserted.exp }, 201);
    }

    const [existing] = await c.get("db").select().from(coupons).where(eq(coupons.id, payload.sub));

    if (!existing) {
      return c.json({ message: "予期せぬエラーが発生しました" }, 500);
    }
    return c.json({ id: existing.id, exp: existing.exp });
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
