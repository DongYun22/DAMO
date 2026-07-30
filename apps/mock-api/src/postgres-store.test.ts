import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
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

  it("computes vote results with correct ranking and tie detection", async () => {
    const host = await store.signup("host-results", "호스트", "pw1234");
    const guest = await store.signup("guest-results", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "결과 테스트",
      capacity: 4,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-results-a",
        naverPlaceId: "naver-results-a",
        name: "가나다식당",
        category: "식당",
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
        id: "place-results-b",
        naverPlaceId: "naver-results-b",
        name: "마바사식당",
        category: "식당",
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
      "MEAL",
      "FUN"
    );
    const guestPlace = await store.registerUserPlace(
      guest.user.id,
      placeB!.naverPlaceId,
      "MEAL",
      "FUN"
    );
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    await store.saveChoice(meeting.id, host.user.id, 1, hostSession.round!.candidateA.id);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    await store.saveChoice(meeting.id, guest.user.id, 1, guestSession.round!.candidateA.id);

    const results = await store.voteResults(meeting.id, host.user.id);
    assert.equal(results.totalMembers, 2);
    assert.equal(results.completedMembers, 2);
    assert.equal(results.incompleteMembers, 0);
    assert.equal(
      results.results.reduce((sum, item) => sum + item.voteCount, 0),
      2
    );
    assert.equal(results.results.filter((item) => item.rank === 1).length, 2);
    assert.equal(results.tiedFirstCandidateIds.length, 2);
    assert.equal(results.results.every((item) => item.isJointRank), true);
  });

  it("looks up a meeting by join code without loading the whole database", async () => {
    const host = await store.signup("host-lookup", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "조회 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });

    const found = await store.lookupMeeting(meeting.joinCode!);
    assert.equal(found.id, meeting.id);
    assert.equal(found.currentMembers, 1);
    assert.equal(found.canJoin, true);

    await assert.rejects(() => store.lookupMeeting("0000"), (error: unknown) => {
      return (error as { code?: string }).code === "MEETING_NOT_FOUND";
    });
  });

  it("reports canJoin=false at capacity and drops LEFT members from currentMembers", async () => {
    const host = await store.signup("host-capacity", "호스트", "pw1234");
    const guest = await store.signup("guest-capacity", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "정원 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const full = await store.lookupMeeting(meeting.joinCode!);
    assert.equal(full.currentMembers, 2);
    assert.equal(full.canJoin, false);

    await store.leaveMeeting(meeting.id, guest.user.id);

    const afterLeave = await store.lookupMeeting(meeting.joinCode!);
    assert.equal(afterLeave.currentMembers, 1);
    assert.equal(afterLeave.canJoin, true);
  });

  it("does not find a meeting by join code once it has been deleted", async () => {
    const host = await store.signup("host-deleted", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "삭제 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    const joinCode = meeting.joinCode!;

    await store.deleteMeeting(meeting.id, host.user.id);

    await assert.rejects(() => store.lookupMeeting(joinCode), (error: unknown) => {
      return (error as { code?: string }).code === "MEETING_NOT_FOUND";
    });
  });

  it("deletes a meeting and rejects non-hosts", async () => {
    const host = await store.signup("host-delete", "호스트", "pw1234");
    const guest = await store.signup("guest-delete", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "삭제 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    await assert.rejects(
      () => store.deleteMeeting(meeting.id, guest.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const result = await store.deleteMeeting(meeting.id, host.user.id);
    assert.equal(result.deleted, true);

    await assert.rejects(
      () => store.detail(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "MEETING_ACCESS_DENIED"
    );
  });

  it("joins a meeting, rejects wrong codes, and enforces capacity", async () => {
    const host = await store.signup("host-join", "호스트", "pw1234");
    const guest = await store.signup("guest-join", "게스트", "pw1234");
    const bystander = await store.signup("bystander-join", "구경꾼", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "가입 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "BUSINESS"
    });

    await assert.rejects(
      () => store.joinMeeting(guest.user.id, meeting.id, "0000", "게스트닉"),
      (error: unknown) => (error as { code?: string }).code === "INVALID_JOIN_CODE"
    );

    const joined = await store.joinMeeting(
      guest.user.id,
      meeting.id,
      meeting.joinCode!,
      "게스트닉"
    );
    assert.equal(joined.members.length, 2);

    await assert.rejects(
      () => store.joinMeeting(bystander.user.id, meeting.id, meeting.joinCode!, "구경꾼닉"),
      (error: unknown) => (error as { code?: string }).code === "MEETING_CAPACITY_EXCEEDED"
    );
  });

  it("rejects a LEFT member's rejoin once their freed slot is taken by someone else", async () => {
    const host = await store.signup("host-rejoin-full", "호스트", "pw1234");
    const guest = await store.signup("guest-rejoin-full", "게스트", "pw1234");
    const third = await store.signup("third-rejoin-full", "써드", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "재입장 정원 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "FUN"
    });

    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");
    await store.leaveMeeting(meeting.id, guest.user.id);

    // Third user fills the slot the guest just vacated.
    await store.joinMeeting(third.user.id, meeting.id, meeting.joinCode!, "써드닉");

    // The guest's old (LEFT) membership row still exists, but the meeting is
    // full again, so rejoining must be rejected rather than silently
    // reactivating past capacity.
    await assert.rejects(
      () => store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉2"),
      (error: unknown) => (error as { code?: string }).code === "MEETING_CAPACITY_EXCEEDED"
    );
  });

  it("reactivates a LEFT member on rejoin when there is room, refreshing their nickname and keeping their role", async () => {
    const host = await store.signup("host-rejoin-room", "호스트", "pw1234");
    const guest = await store.signup("guest-rejoin-room", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "재입장 여유 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "FUN"
    });

    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");
    await store.leaveMeeting(meeting.id, guest.user.id);

    const rejoined = await store.joinMeeting(
      guest.user.id,
      meeting.id,
      meeting.joinCode!,
      "새닉네임"
    );
    assert.equal(rejoined.members.length, 2);

    const detail = await store.detail(meeting.id, host.user.id);
    const rejoinedMember = detail.members.find((member) => member.userId === guest.user.id);
    assert.ok(rejoinedMember);
    assert.equal(rejoinedMember!.status, "ACTIVE");
    assert.equal(rejoinedMember!.meetingNickname, "새닉네임");
    assert.equal(rejoinedMember!.role, "MEMBER");
  });

  it("creates a meeting with a unique join code and a host member", async () => {
    const host = await store.signup("host-create", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "생성 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });

    assert.equal(meeting.hostUserId, host.user.id);
    assert.match(meeting.joinCode!, /^\d{4}$/);
    assert.equal(meeting.members.length, 1);
    assert.equal(meeting.members[0]!.role, "HOST");
    assert.equal(meeting.status, "RECRUITING");
  });

  it("retries the join code when the first candidate collides", async () => {
    const host = await store.signup("host-collision", "호스트", "pw1234");

    // Pin Math.random so the *first* join-code attempt of each of the two
    // createMeeting calls below computes the identical 4-digit candidate,
    // forcing a real 23505 unique-violation collision on the second call's
    // first insert attempt. After the first two calls, fall back to the
    // real Math.random so the retry (attempt #2 of the second call) can
    // find a fresh, non-colliding code.
    const realRandom = Math.random.bind(Math);
    let callCount = 0;
    const randomMock = mock.method(Math, "random", () => {
      callCount += 1;
      return callCount <= 2 ? 0.5 : realRandom();
    });

    let first: Awaited<ReturnType<typeof store.createMeeting>>;
    let second: Awaited<ReturnType<typeof store.createMeeting>>;
    try {
      first = await store.createMeeting(host.user.id, {
        name: "충돌 테스트 1",
        capacity: 2,
        meetingAt: "2026-08-01T10:00:00+09:00",
        purpose: "CAFE",
        mood: "FUN"
      });
      second = await store.createMeeting(host.user.id, {
        name: "충돌 테스트 2",
        capacity: 2,
        meetingAt: "2026-08-01T10:00:00+09:00",
        purpose: "CAFE",
        mood: "FUN"
      });
    } finally {
      randomMock.mock.restore();
    }

    // Both calls pinned Math.random to 0.5 for their first attempt, so
    // without the savepoint fix the second call's first insert would hit
    // 23505 and (pre-fix) abort the transaction, making every subsequent
    // statement in that transaction fail with 25P02. Proving the second
    // call still succeeded, with a join code different from the first,
    // demonstrates the retry loop actually recovered from a real collision.
    assert.equal(first.joinCode, "5500");
    assert.match(second.joinCode!, /^\d{4}$/);
    assert.notEqual(second.joinCode, first.joinCode);
    // At least 3 Math.random calls means: call 1's single attempt, call 2's
    // colliding first attempt, and call 2's successful retry attempt.
    assert.ok(
      callCount >= 3,
      `expected the retry loop to consume at least 3 Math.random calls, got ${callCount}`
    );
  });
});
