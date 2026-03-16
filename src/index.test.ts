import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { TZDate } from "@date-fns/tz";
import { addDays, addMonths, endOfDay, endOfMonth, getUnixTime } from "date-fns";
import { drizzle } from "drizzle-orm/libsql";
import { testClient } from "hono/testing";
import { COUPON_EXPIRE_MONTHS, createApp, SURVEY_EXPIRE_DAYS, TIMEZONE, type AppType } from "./index";
import { env } from "../env";
import { migrate } from "drizzle-orm/libsql/migrator";

let client: ReturnType<typeof testClient<AppType>>;

beforeEach(async () => {
  const db = drizzle(env.DB_FILE_NAME);
  await migrate(db, { migrationsFolder: "./drizzle" });
  client = testClient(createApp(db));
});

afterEach(async () => {
  setSystemTime();
});

const adminHeaders = {
  Authorization: `Basic ${btoa(`${env.BA_USERNAME}:${env.BA_PASSWORD}`)}`,
};

// /api/admin/issue 経由でトークンを発行する
async function issueToken() {
  const response = await client.api.admin.issue.$post({}, { headers: adminHeaders });
  return response.json();
}

describe("POST /api/admin/issue", () => {
  test("Basic認証なしは401", async () => {
    const response = await client.api.admin.issue.$post({});
    expect(response.status).toBe(401);
  });

  test("アンケート回答期限はTIMEZONEでSURVEY_EXPIRE_DAYS日後の終わり", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00+09:00"));

    const actual = await issueToken();

    const expected = getUnixTime(endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS)));
    expect(actual.surveyExp).toBe(expected);
  });
});

describe("GET /api/status", () => {
  test("不正なトークンは401", async () => {
    const response = await client.api.status.$get({ query: { token: "invalid.token.here" } });
    expect(response.status).toBe(401);
  });

  test("アンケート未回答→unanswered", async () => {
    const { token } = await issueToken();
    const response = await client.api.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("unanswered");
  });

  test("アンケート回答期限切れ→survey expired", async () => {
    const { token } = await issueToken();

    setSystemTime(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS + 1));

    const response = await client.api.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("survey expired");
  });

  test("クーポン発行済み→active", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });

    const response = await client.api.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("active");
  });

  test("クーポン使用済み→used", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });
    await client.api.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await client.api.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("used");
  });

  test("クーポン有効期限切れ→coupon expired", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });

    setSystemTime(addMonths(endOfMonth(TZDate.tz(TIMEZONE)), COUPON_EXPIRE_MONTHS + 1));

    const response = await client.api.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("coupon expired");
  });
});

describe("POST /api/answer", () => {
  test("回答するとクーポンが発行される(201)", async () => {
    const { token } = await issueToken();
    const response = await client.api.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    expect(response.status).toBe(201);
  });

  test("クーポン有効期限はTIMEZONEで翌月末", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00+09:00"));

    const { token } = await issueToken();
    const response = await client.api.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();

    const expectedExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    expect(getUnixTime(new Date(actual.exp))).toBe(getUnixTime(expectedExp));
  });

  test("二重回答は既存クーポンを返す(200)", async () => {
    const { token } = await issueToken();
    const response1 = await client.api.answer.$post({ query: { token } });
    if (response1.status !== 201) {
      throw new Error(`レスポンスステータス: ${response1.status}`);
    }
    const actual1 = await response1.json();

    const response2 = await client.api.answer.$post({ query: { token } });
    if (response2.status !== 200) {
      throw new Error(`レスポンスステータス: ${response2.status}`);
    }
    const actual2 = await response2.json();

    expect(actual1.id).toBe(actual2.id);
  });

  test("アンケート回答期限切れは400", async () => {
    const { token } = await issueToken();
    setSystemTime(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS + 1));

    const response = await client.api.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("アンケートの回答期限が過ぎています");
  });

  test("クーポンが使用済みの場合は400", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });
    await client.api.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await client.api.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("このクーポンは既に使用されています");
  });
});

describe("PUT /api/admin/use", () => {
  test("Basic認証なしは401", async () => {
    const { token } = await issueToken();
    const response = await client.api.admin.use.$put({ query: { token } });
    expect(response.status).toBe(401);
  });

  test("クーポンを使用済みにできる", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });

    const response = await client.api.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.usedAt).not.toBeNull();
  });

  test("クーポン未発行(アンケート未回答)は404", async () => {
    const { token } = await issueToken();

    const response = await client.api.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 404) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("このクーポンは無効です");
  });

  test("使用済みクーポンの再使用は400", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });
    await client.api.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await client.api.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("このクーポンは既に使用されています");
  });

  test("期限切れクーポンの使用は400", async () => {
    const { token } = await issueToken();
    await client.api.answer.$post({ query: { token } });

    setSystemTime(addMonths(endOfMonth(TZDate.tz(TIMEZONE)), COUPON_EXPIRE_MONTHS + 1));

    const response = await client.api.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe("クーポンの有効期限が切れています");
  });
});
