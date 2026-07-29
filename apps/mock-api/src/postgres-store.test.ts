import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PostgresStore } from "./postgres-store.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

// Returns true only if `value` (lower-cased) contains "test" as a whole
// segment once split on non-alphanumeric characters (so "damo_test" and
// "test-db.example.com" match, but "latest", "attest", "protest", etc. do
// not, unlike a naive `/test/i.test(value)` substring check).
function containsTestWord(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .includes("test");
}

// Structural (not substring) check that a Postgres connection string points
// at a throwaway/local database: either the hostname is exactly a loopback
// address, or the hostname/database name contains the whole word "test".
function isSafeTestConnectionString(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  return containsTestWord(hostname) || containsTestWord(parsed.pathname);
}

// Describes the connection target without ever including userinfo
// (`user:password@`), so it's safe to print in error messages/CI logs even
// when TEST_DATABASE_URL turns out to be a real, credentialed database.
function describeConnectionTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const database = parsed.pathname.replace(/^\//, "") || "(no database specified)";
    const port = parsed.port || "(default port)";
    return `host="${parsed.hostname}" port="${port}" database="${database}"`;
  } catch {
    return "(unparseable connection string)";
  }
}

describe("PostgresStore (integration)", { skip: !testDatabaseUrl }, () => {
  let store: PostgresStore;

  before(() => {
    // Safety guard: `beforeEach` below calls `store.reset()`, which truncates
    // every table. Refuse to run unless the connection string clearly points
    // at a throwaway/local database, so a copy-paste mistake (e.g. reusing
    // the production DATABASE_URL as TEST_DATABASE_URL) can't wipe real data.
    if (!isSafeTestConnectionString(testDatabaseUrl!)) {
      throw new Error(
        `Refusing to run destructive PostgresStore integration tests: TEST_DATABASE_URL ` +
          `does not look like a test/local database (${describeConnectionTarget(testDatabaseUrl!)}). ` +
          `Expected the hostname to be localhost/127.0.0.1/::1, or the hostname/database name to ` +
          `contain the whole word "test". This suite calls store.reset(), which truncates every table.`,
      );
    }

    process.env.DATABASE_URL = testDatabaseUrl;
    store = new PostgresStore();
  });

  beforeEach(async () => {
    await store.reset();
  });

  after(async () => {
    await store.close();
  });

  it("connects to the test database", async () => {
    await store.healthCheck();
  });

  it("replaceMyCandidates and saveChoice still work after the lock refactor", async () => {
    const host = await store.signup("host-lock", "호스트", "pw1234");
    const guest = await store.signup("guest-lock", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "락 테스트",
      capacity: 4,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "FUN"
    });
    const joined = await store.joinMeeting(
      guest.user.id,
      meeting.id,
      meeting.joinCode!,
      "게스트닉"
    );
    assert.equal(joined.members.length, 2);

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-lock-a",
        naverPlaceId: "naver-lock-a",
        name: "A카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-lock-b",
        naverPlaceId: "naver-lock-b",
        name: "B카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(
      host.user.id,
      placeA!.naverPlaceId,
      "CAFE",
      "FUN"
    );
    const guestPlace = await store.registerUserPlace(
      guest.user.id,
      placeB!.naverPlaceId,
      "CAFE",
      "FUN"
    );

    const hostCandidates = await store.replaceMyCandidates(meeting.id, host.user.id, [
      hostPlace.id
    ]);
    assert.equal(hostCandidates.length, 1);
    const guestCandidates = await store.replaceMyCandidates(meeting.id, guest.user.id, [
      guestPlace.id
    ]);
    assert.equal(guestCandidates.length, 2);

    const vote = await store.createVote(meeting.id, host.user.id);
    const session = await store.voteSession(meeting.id, host.user.id);
    assert.ok(session.round);
    const saved = await store.saveChoice(
      meeting.id,
      host.user.id,
      1,
      session.round!.candidateA.id
    );
    assert.equal(saved.completedRounds, 1);
    assert.equal(vote.voteId.length > 0, true);
  });
});
