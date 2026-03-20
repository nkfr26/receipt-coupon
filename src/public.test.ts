import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { TZDate } from "@date-fns/tz";
import { addDays, addMonths, endOfDay, endOfMonth, getUnixTime } from "date-fns";
import { drizzle } from "drizzle-orm/libsql";
import { testClient } from "hono/testing";
import { createApp } from "./index";
import { env } from "../env";
import { migrate } from "drizzle-orm/libsql/migrator";
import { AdminAppType } from "./admin";
import { PublicAppType } from "./public";
import { TIMEZONE, SURVEY_EXPIRE_DAYS, COUPON_EXPIRE_MONTHS } from "./utils";

let adminClient: ReturnType<typeof testClient<AdminAppType>>;
let publicClient: ReturnType<typeof testClient<PublicAppType>>;

beforeEach(async () => {
  const db = drizzle(env.DB_FILE_NAME);
  await migrate(db, { migrationsFolder: "./drizzle" });

  const app = createApp(db);
  adminClient = testClient<AdminAppType>(app);
  publicClient = testClient<PublicAppType>(app);
});

afterEach(async () => {
  setSystemTime();
});

const adminHeaders = {
  Authorization: `Basic ${btoa(`${env.BA_USERNAME}:${env.BA_PASSWORD}`)}`,
};

// /api/admin/issue 経由でトークンを発行する
async function issueToken() {
  const response = await adminClient.admin.issue.$post({}, { headers: adminHeaders });
  if (!response.ok) {
    throw new Error(`レスポンスステータス: ${response.status}`);
  }
  return response.json();
}

describe("GET /api/status", () => {
  test("トークンなしは400", async () => {
    const response = await publicClient.public.status.$get({ query: {} });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("このURLは無効です");
  });

  test("不正なトークンは401", async () => {
    const response = await publicClient.public.status.$get({ query: { token: "invalid.token.here" } });
    expect(response.status).toBe(401);
  });

  test("アンケート回答期限切れ", async () => {
    const { token } = await issueToken();

    setSystemTime(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS + 1));

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("survey expired");
  });

  test("アンケート未回答", async () => {
    const { token } = await issueToken();
    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("unanswered");
  });

  test("クーポン有効期限切れ", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    setSystemTime(addMonths(endOfMonth(TZDate.tz(TIMEZONE)), COUPON_EXPIRE_MONTHS + 1));

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("coupon expired");
  });

  test("クーポン使用済み", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });
    await adminClient.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("used");
  });

  test("有効なクーポン", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("active");
  });
});

describe("POST /api/answer", () => {
  test("回答すると201でクーポンが発行される", async () => {
    const { token } = await issueToken();
    const response = await publicClient.public.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    expect(response.status).toBe(201);
  });

  test("クーポン有効期限はTIMEZONEでCOUPON_EXPIRE_MONTHSか月後末まで", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00+09:00"));

    const { token } = await issueToken();
    const response = await publicClient.public.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();

    const expectedExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    expect(getUnixTime(new Date(actual.exp))).toBe(getUnixTime(expectedExp));
  });

  test("二重回答は200で既存クーポンを返す", async () => {
    const { token } = await issueToken();
    const response1 = await publicClient.public.answer.$post({ query: { token } });
    if (!response1.ok) {
      throw new Error(`レスポンスステータス: ${response1.status}`);
    }
    expect(response1.status).toBe(201);

    const response2 = await publicClient.public.answer.$post({ query: { token } });
    if (!response2.ok) {
      throw new Error(`レスポンスステータス: ${response2.status}`);
    }
    expect(response2.status).toBe(200);
  });

  test("アンケート回答期限切れは400", async () => {
    const { token } = await issueToken();
    setSystemTime(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS + 1));

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("アンケートの回答期限が過ぎています");
  });

  test("クーポンが使用済みの場合は400", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });
    await adminClient.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("このクーポンは既に使用されています");
  });
});
