import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Client } from "pg";
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

  it("creates a vote with frozen candidates and rotated N-1 sessions", async () => {
    const host = await store.signup("host-vote", "호스트", "pw1234");
    const guest = await store.signup("guest-vote", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "투표 생성 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-vote-a",
        naverPlaceId: "naver-vote-a",
        name: "가식당",
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
        id: "place-vote-b",
        naverPlaceId: "naver-vote-b",
        name: "나식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const [placeC] = await store.upsertPlaces([
      {
        id: "place-vote-c",
        naverPlaceId: "naver-vote-c",
        name: "다식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.7,
        longitude: 127.2,
        station: "홍대",
        distanceText: "3분"
      }
    ]);
    const hostPlaceA = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "MEAL", "FUN");
    const hostPlaceB = await store.registerUserPlace(host.user.id, placeB!.naverPlaceId, "MEAL", "FUN");
    const guestPlaceC = await store.registerUserPlace(guest.user.id, placeC!.naverPlaceId, "MEAL", "FUN");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlaceA.id, hostPlaceB.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlaceC.id]);

    await assert.rejects(
      () => store.createVote(meeting.id, guest.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const { meeting: detail, voteId } = await store.createVote(meeting.id, host.user.id);
    assert.equal(detail.status, "VOTING");
    assert.ok(voteId);
    assert.equal(
      detail.candidates.every((candidate) => candidate.isFrozen),
      true
    );

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    assert.equal(hostSession.totalRounds, 2);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    assert.equal(guestSession.totalRounds, 2);

    await assert.rejects(
      () => store.createVote(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "VOTE_ALREADY_CREATED"
    );
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

  it("closes a vote with a single winner and rejects incomplete closes without force", async () => {
    const host = await store.signup("host-close", "호스트", "pw1234");
    const guest = await store.signup("guest-close", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "종료 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-close-a",
        naverPlaceId: "naver-close-a",
        name: "가카페",
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
        id: "place-close-b",
        naverPlaceId: "naver-close-b",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "CAFE", "QUIET");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    await assert.rejects(
      () => store.closeVote(meeting.id, host.user.id, false),
      (error: unknown) => (error as { code?: string }).code === "VOTE_HAS_INCOMPLETE_MEMBERS"
    );

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, host.user.id, 1, hostChoiceId);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateA.id
        : guestSession.round!.candidateB.id;
    await store.saveChoice(meeting.id, guest.user.id, 1, guestChoiceId);

    const results = await store.closeVote(meeting.id, host.user.id, false);
    assert.equal(results.voteStatus, "CLOSED");
    assert.equal(results.meetingStatus, "COMPLETED");
    assert.equal(results.finalCandidateId !== null, true);
  });

  it("closes a tied vote into FINAL_SELECTION without picking a winner or recurring", async () => {
    const host = await store.signup("host-close-tie", "호스트", "pw1234");
    const guest = await store.signup("guest-close-tie", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "동점 종료 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-close-tie-a",
        naverPlaceId: "naver-close-tie-a",
        name: "가카페",
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
        id: "place-close-tie-b",
        naverPlaceId: "naver-close-tie-b",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "CAFE", "QUIET");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, host.user.id, 1, hostChoiceId);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    // Pick whichever of the guest's candidates is NOT the one the host chose,
    // so the two members deliberately split their votes 1-1 into a genuine
    // tie, regardless of how candidate order is rotated per member.
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateB.id
        : guestSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, guest.user.id, 1, guestChoiceId);

    const results = await store.closeVote(meeting.id, host.user.id, false);
    assert.equal(results.voteStatus, "FINAL_SELECTION");
    assert.equal(results.meetingStatus, "FINAL_SELECTION");
    assert.equal(results.finalCandidateId, null);
    assert.equal(results.tiedFirstCandidateIds.length, 2);

    // createNextRecurringOccurrence must not have fired for a tie: the
    // meeting should still be sitting in FINAL_SELECTION, not COMPLETED.
    const detail = await store.detail(meeting.id, host.user.id);
    assert.equal(detail.status, "FINAL_SELECTION");
  });

  it("creates the next recurring occurrence when closeVote resolves a repeated meeting to a single winner", async () => {
    const host = await store.signup("host-recur", "호스트", "pw1234");

    // --- Meeting A: run to COMPLETED so it can be repeated. ---
    const meetingA = await store.createMeeting(host.user.id, {
      name: "반복 테스트 1회차",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });

    const [placeA1] = await store.upsertPlaces([
      {
        id: "place-recur-a1",
        naverPlaceId: "naver-recur-a1",
        name: "가카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeA2] = await store.upsertPlaces([
      {
        id: "place-recur-a2",
        naverPlaceId: "naver-recur-a2",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlaceA1 = await store.registerUserPlace(host.user.id, placeA1!.naverPlaceId, "CAFE", "QUIET");
    const hostPlaceA2 = await store.registerUserPlace(host.user.id, placeA2!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meetingA.id, host.user.id, [hostPlaceA1.id, hostPlaceA2.id]);
    await store.createVote(meetingA.id, host.user.id);

    const sessionA = await store.voteSession(meetingA.id, host.user.id);
    await store.saveChoice(meetingA.id, host.user.id, 1, sessionA.round!.candidateA.id);
    const resultsA = await store.closeVote(meetingA.id, host.user.id, false);
    assert.equal(resultsA.meetingStatus, "COMPLETED");

    // --- Repeat meeting A into meeting B with WEEKLY recurrence. ---
    // repeatMeeting still runs on the legacy snapshot write() path (not part
    // of this task's conversion scope); it's only used here as test setup to
    // reach a meeting with recurrenceType set, since that field can't be set
    // via plain createMeeting.
    const detailA = await store.detail(meetingA.id, host.user.id);
    const hostMemberA = detailA.members.find((member) => member.role === "HOST")!;
    const meetingB = await store.repeatMeeting(meetingA.id, host.user.id, {
      name: "반복 테스트 2회차",
      capacity: 2,
      meetingAt: "2026-08-08T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET",
      memberIds: [hostMemberA.id],
      recurrence: { type: "WEEKLY" }
    });
    assert.equal(meetingB.status, "RECRUITING");
    assert.equal(meetingB.parentMeetingId, meetingA.id);
    assert.equal(meetingB.recurrence?.type, "WEEKLY");
    const seriesId = meetingB.seriesId ?? meetingA.id;
    assert.equal(seriesId, meetingA.id);

    // --- Run meeting B through candidates/vote to another single-winner close. ---
    const [placeB1] = await store.upsertPlaces([
      {
        id: "place-recur-b1",
        naverPlaceId: "naver-recur-b1",
        name: "다카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.7,
        longitude: 127.2,
        station: "홍대",
        distanceText: "3분"
      }
    ]);
    const [placeB2] = await store.upsertPlaces([
      {
        id: "place-recur-b2",
        naverPlaceId: "naver-recur-b2",
        name: "라카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.8,
        longitude: 127.3,
        station: "합정",
        distanceText: "4분"
      }
    ]);
    const hostPlaceB1 = await store.registerUserPlace(host.user.id, placeB1!.naverPlaceId, "CAFE", "QUIET");
    const hostPlaceB2 = await store.registerUserPlace(host.user.id, placeB2!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meetingB.id, host.user.id, [hostPlaceB1.id, hostPlaceB2.id]);
    await store.createVote(meetingB.id, host.user.id);
    const sessionB = await store.voteSession(meetingB.id, host.user.id);
    await store.saveChoice(meetingB.id, host.user.id, 1, sessionB.round!.candidateA.id);
    const resultsB = await store.closeVote(meetingB.id, host.user.id, false);
    assert.equal(resultsB.meetingStatus, "COMPLETED");

    // --- Assert createNextRecurringOccurrence fired: a meeting C exists as a
    // child of B, RECRUITING, carrying the WEEKLY recurrence and series id
    // forward. ---
    const home = await store.home(host.user.id);
    const allMeetings = [...home.ongoingMeetings, ...home.completedMeetings];
    const meetingC = allMeetings.find((item) => item.parentMeetingId === meetingB.id);
    assert.ok(meetingC, "expected a next occurrence meeting to exist");
    assert.equal(meetingC!.status, "RECRUITING");
    assert.equal(meetingC!.seriesId, seriesId);
    assert.equal(meetingC!.recurrence?.type, "WEEKLY");

    // Meeting B itself should no longer be eligible to repeat again (its
    // nextMeetingId is now set), confirmed via repeatMeeting rejecting.
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingB.id, host.user.id, {
          name: "반복 테스트 3회차",
          capacity: 2,
          meetingAt: "2026-08-15T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id],
          recurrence: { type: "WEEKLY" }
        }),
      (error: unknown) => (error as { code?: string }).code === "NEXT_MEETING_ALREADY_EXISTS"
    );
  });

  it("resolves a tied vote via finalSelection and starts the next recurring occurrence", async () => {
    const host = await store.signup("host-final", "호스트", "pw1234");
    const guest = await store.signup("guest-final", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "최종선택 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-final-a",
        naverPlaceId: "naver-final-a",
        name: "가호프",
        category: "호프",
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
        id: "place-final-b",
        naverPlaceId: "naver-final-b",
        name: "나호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "DRINK", "TIPSY");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, host.user.id, 1, hostChoiceId);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateB.id
        : guestSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, guest.user.id, 1, guestChoiceId);

    const closed = await store.closeVote(meeting.id, host.user.id, false);
    assert.equal(closed.meetingStatus, "FINAL_SELECTION");
    assert.equal(closed.tiedFirstCandidateIds.length, 2);

    await assert.rejects(
      () => store.finalSelection(meeting.id, host.user.id, "not-a-real-candidate-id"),
      (error: unknown) => (error as { code?: string }).code === "INVALID_FINAL_CANDIDATE"
    );

    const finalPick = closed.tiedFirstCandidateIds[0]!;
    const final = await store.finalSelection(meeting.id, host.user.id, finalPick);
    assert.equal(final.meetingStatus, "COMPLETED");
    assert.equal(final.finalCandidateId, finalPick);
  });

  it("creates the next recurring occurrence when finalSelection resolves a repeated meeting's tie", async () => {
    const host = await store.signup("host-final-recur", "호스트", "pw1234");

    // --- Meeting A: run to COMPLETED so it can be repeated. ---
    const meetingA = await store.createMeeting(host.user.id, {
      name: "최종선택 반복 테스트 1회차",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });

    const [placeA1] = await store.upsertPlaces([
      {
        id: "place-final-recur-a1",
        naverPlaceId: "naver-final-recur-a1",
        name: "가카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeA2] = await store.upsertPlaces([
      {
        id: "place-final-recur-a2",
        naverPlaceId: "naver-final-recur-a2",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlaceA1 = await store.registerUserPlace(host.user.id, placeA1!.naverPlaceId, "CAFE", "QUIET");
    const hostPlaceA2 = await store.registerUserPlace(host.user.id, placeA2!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meetingA.id, host.user.id, [hostPlaceA1.id, hostPlaceA2.id]);
    await store.createVote(meetingA.id, host.user.id);

    const sessionA = await store.voteSession(meetingA.id, host.user.id);
    await store.saveChoice(meetingA.id, host.user.id, 1, sessionA.round!.candidateA.id);
    const resultsA = await store.closeVote(meetingA.id, host.user.id, false);
    assert.equal(resultsA.meetingStatus, "COMPLETED");

    // --- Repeat meeting A into meeting B with WEEKLY recurrence. ---
    // repeatMeeting still runs on the legacy snapshot write() path (not part
    // of this task's conversion scope); it's only used here as test setup to
    // reach a meeting with recurrenceType set, since that field can't be set
    // via plain createMeeting.
    const detailA = await store.detail(meetingA.id, host.user.id);
    const hostMemberA = detailA.members.find((member) => member.role === "HOST")!;
    const meetingB = await store.repeatMeeting(meetingA.id, host.user.id, {
      name: "최종선택 반복 테스트 2회차",
      capacity: 2,
      meetingAt: "2026-08-08T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET",
      memberIds: [hostMemberA.id],
      recurrence: { type: "WEEKLY" }
    });
    assert.equal(meetingB.status, "RECRUITING");
    assert.equal(meetingB.parentMeetingId, meetingA.id);
    assert.equal(meetingB.recurrence?.type, "WEEKLY");
    const seriesId = meetingB.seriesId ?? meetingA.id;
    assert.equal(seriesId, meetingA.id);

    // --- Join a guest and run meeting B through candidates/vote into a tie,
    // so closeVote lands it in FINAL_SELECTION instead of picking a winner. ---
    const guest = await store.signup("guest-final-recur", "게스트", "pw1234");
    await store.joinMeeting(guest.user.id, meetingB.id, meetingB.joinCode!, "게스트닉");

    const [placeB1] = await store.upsertPlaces([
      {
        id: "place-final-recur-b1",
        naverPlaceId: "naver-final-recur-b1",
        name: "다카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.7,
        longitude: 127.2,
        station: "홍대",
        distanceText: "3분"
      }
    ]);
    const [placeB2] = await store.upsertPlaces([
      {
        id: "place-final-recur-b2",
        naverPlaceId: "naver-final-recur-b2",
        name: "라카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.8,
        longitude: 127.3,
        station: "합정",
        distanceText: "4분"
      }
    ]);
    const hostPlaceB = await store.registerUserPlace(host.user.id, placeB1!.naverPlaceId, "CAFE", "QUIET");
    const guestPlaceB = await store.registerUserPlace(guest.user.id, placeB2!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meetingB.id, host.user.id, [hostPlaceB.id]);
    await store.replaceMyCandidates(meetingB.id, guest.user.id, [guestPlaceB.id]);
    await store.createVote(meetingB.id, host.user.id);

    const hostSessionB = await store.voteSession(meetingB.id, host.user.id);
    const hostChoiceIdB = hostSessionB.round!.candidateA.id;
    await store.saveChoice(meetingB.id, host.user.id, 1, hostChoiceIdB);
    const guestSessionB = await store.voteSession(meetingB.id, guest.user.id);
    const guestChoiceIdB =
      guestSessionB.round!.candidateA.id === hostChoiceIdB
        ? guestSessionB.round!.candidateB.id
        : guestSessionB.round!.candidateA.id;
    await store.saveChoice(meetingB.id, guest.user.id, 1, guestChoiceIdB);

    const closedB = await store.closeVote(meetingB.id, host.user.id, false);
    assert.equal(closedB.meetingStatus, "FINAL_SELECTION");
    assert.equal(closedB.tiedFirstCandidateIds.length, 2);

    // --- Resolve the tie via finalSelection: this exercises finalSelection's
    // OWN call into createNextRecurringOccurrence, a different code path from
    // closeVote's single-winner branch tested above. ---
    const finalPickB = closedB.tiedFirstCandidateIds[0]!;
    const finalB = await store.finalSelection(meetingB.id, host.user.id, finalPickB);
    assert.equal(finalB.meetingStatus, "COMPLETED");
    assert.equal(finalB.finalCandidateId, finalPickB);

    // --- Assert createNextRecurringOccurrence fired: a meeting C exists as a
    // child of B, RECRUITING, carrying the WEEKLY recurrence and series id
    // forward. ---
    const home = await store.home(host.user.id);
    const allMeetings = [...home.ongoingMeetings, ...home.completedMeetings];
    const meetingC = allMeetings.find((item) => item.parentMeetingId === meetingB.id);
    assert.ok(meetingC, "expected a next occurrence meeting to exist");
    assert.equal(meetingC!.status, "RECRUITING");
    assert.equal(meetingC!.seriesId, seriesId);
    assert.equal(meetingC!.recurrence?.type, "WEEKLY");

    // Meeting B itself should no longer be eligible to repeat again (its
    // nextMeetingId is now set), confirmed via repeatMeeting rejecting.
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingB.id, host.user.id, {
          name: "최종선택 반복 테스트 3회차",
          capacity: 2,
          meetingAt: "2026-08-15T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id],
          recurrence: { type: "WEEKLY" }
        }),
      (error: unknown) => (error as { code?: string }).code === "NEXT_MEETING_ALREADY_EXISTS"
    );
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

  it("lets an active member leave and rejects the host", async () => {
    const host = await store.signup("host-leave", "호스트", "pw1234");
    const guest = await store.signup("guest-leave", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "탈퇴 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    await assert.rejects(
      () => store.leaveMeeting(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_CANNOT_LEAVE"
    );

    const result = await store.leaveMeeting(meeting.id, guest.user.id);
    assert.equal(result.left, true);

    const detail = await store.detail(meeting.id, host.user.id);
    assert.equal(detail.members.length, 1);
  });

  it("lets the host kick a member and rejects non-hosts / kicking the host", async () => {
    const host = await store.signup("host-kick", "호스트", "pw1234");
    const guest = await store.signup("guest-kick", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "강퇴 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    const joined = await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");
    const guestMemberId = joined.members.find((member) => member.userId === guest.user.id)!.id;

    await assert.rejects(
      () => store.kickMember(meeting.id, guest.user.id, guestMemberId),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const detail = await store.kickMember(meeting.id, host.user.id, guestMemberId);
    assert.equal(detail.members.length, 1);
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

  it("rejects a KICKED member's rejoin attempt regardless of capacity", async () => {
    const host = await store.signup("host-kicked-rejoin", "호스트", "pw1234");
    const guest = await store.signup("guest-kicked-rejoin", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "강퇴 재입장 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "FUN"
    });

    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const detail = await store.detail(meeting.id, host.user.id);
    const guestMember = detail.members.find((member) => member.userId === guest.user.id);
    assert.ok(guestMember);

    await store.kickMember(meeting.id, host.user.id, guestMember!.id);

    // Plenty of room left (capacity 3, only the host remains), but a KICKED
    // member must never be allowed to walk back in with the join code.
    await assert.rejects(
      () => store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉2"),
      (error: unknown) => (error as { code?: string }).code === "PREVIOUSLY_KICKED"
    );
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

  it("updates a user place and reflects the change onto an active RECRUITING candidate", async () => {
    const host = await store.signup("host-update-place", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "장소수정 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-update-a",
        naverPlaceId: "naver-update-a",
        name: "가카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const updated = await store.updateUserPlace(
      host.user.id,
      hostPlace.id,
      "MEAL",
      "FUN",
      [meeting.id]
    );
    assert.equal(updated.purpose, "MEAL");
    assert.equal(updated.mood, "FUN");

    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 1);
  });

  it("updates a user place across multiple meetings in one call, skipping a meeting that is no longer RECRUITING", async () => {
    const host = await store.signup("host-update-multi", "호스트", "pw1234");
    const meetingA = await store.createMeeting(host.user.id, {
      name: "장소수정 다중 테스트 A",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    const meetingB = await store.createMeeting(host.user.id, {
      name: "장소수정 다중 테스트 B",
      capacity: 2,
      meetingAt: "2026-08-02T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    // meetingC will be moved out of RECRUITING (into VOTING) before the
    // updateUserPlace call below, so the loop's `continue` branch for a
    // non-RECRUITING meeting is actually exercised, not just meetings that
    // stay RECRUITING throughout.
    const meetingC = await store.createMeeting(host.user.id, {
      name: "장소수정 다중 테스트 C",
      capacity: 2,
      meetingAt: "2026-08-03T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-update-multi-a",
        naverPlaceId: "naver-update-multi-a",
        name: "가카페",
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
        id: "place-update-multi-b",
        naverPlaceId: "naver-update-multi-b",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);

    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "CAFE", "QUIET");
    const hostPlace2 = await store.registerUserPlace(host.user.id, placeB!.naverPlaceId, "CAFE", "QUIET");

    // hostPlace is the candidate in every meeting; meetingC additionally
    // gets hostPlace2 so it has the 2 distinct candidates createVote requires.
    await store.replaceMyCandidates(meetingA.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meetingB.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meetingC.id, host.user.id, [hostPlace.id, hostPlace2.id]);

    await store.createVote(meetingC.id, host.user.id);
    // Capture each meeting's updated_at before the call so we can later prove
    // the RECRUITING meetings' rows were actually touched by the loop while
    // meetingC's (the `continue`-skipped one) was not — publicCandidates
    // alone can't distinguish "updated in place" from "left untouched" here,
    // since Candidate has no purpose/mood field of its own to compare.
    const meetingABeforeUpdate = await store.detail(meetingA.id, host.user.id);
    const meetingBBeforeUpdate = await store.detail(meetingB.id, host.user.id);
    const meetingCBeforeUpdate = await store.detail(meetingC.id, host.user.id);
    assert.equal(meetingCBeforeUpdate.status, "VOTING");

    // Pass the meeting ids in a deliberately non-sorted order to prove the
    // method's own `[...new Set(ids)].sort()` step (not caller-supplied
    // order) is what determines lock-acquisition order, and that the loop
    // still processes every meeting regardless of the order they're passed.
    const updated = await store.updateUserPlace(
      host.user.id,
      hostPlace.id,
      "MEAL",
      "FUN",
      [meetingC.id, meetingB.id, meetingA.id]
    );
    assert.equal(updated.purpose, "MEAL");
    assert.equal(updated.mood, "FUN");

    const candidatesA = await store.publicCandidates(meetingA.id, host.user.id);
    assert.equal(candidatesA.length, 1);
    const candidatesB = await store.publicCandidates(meetingB.id, host.user.id);
    assert.equal(candidatesB.length, 1);

    // meetingA and meetingB were RECRUITING, so each should have hit the
    // `update meetings set updated_at = now()` line at the end of the loop
    // body for that meeting.
    const meetingAAfterUpdate = await store.detail(meetingA.id, host.user.id);
    const meetingBAfterUpdate = await store.detail(meetingB.id, host.user.id);
    assert.notEqual(meetingAAfterUpdate.updatedAt, meetingABeforeUpdate.updatedAt);
    assert.notEqual(meetingBAfterUpdate.updatedAt, meetingBBeforeUpdate.updatedAt);

    // meetingC was VOTING (not RECRUITING) at call time, so the loop should
    // have taken the `continue` branch for it without throwing — its
    // candidates and status are untouched, and the two RECRUITING meetings
    // were still updated in the same call. Critically, meetingC's updated_at
    // must be unchanged too: `continue` skips both the
    // candidate_recommendations update and the meetings.updated_at bump, so
    // if the guard were ever removed, this assertion would fail even though
    // publicCandidates alone can't detect the difference.
    const candidatesC = await store.publicCandidates(meetingC.id, host.user.id);
    assert.equal(candidatesC.length, 2);
    const meetingCAfterUpdate = await store.detail(meetingC.id, host.user.id);
    assert.equal(meetingCAfterUpdate.status, "VOTING");
    assert.equal(meetingCAfterUpdate.updatedAt, meetingCBeforeUpdate.updatedAt);
  });

  it("updates a user place with an empty applyToMeetingIds, updating only the user_places row", async () => {
    // The server's route defaults applyToMeetingIds to [] (server.ts), so
    // this is the common "edit my saved place without applying it anywhere"
    // path, not just an edge case. This test only checks that the call
    // succeeds with an empty list and that user_places ends up with the new
    // purpose/mood — it does NOT verify that no locks were taken or that the
    // per-meeting loops ran zero times (there's no lock/loop instrumentation
    // here to observe that; with zero meeting ids that behavior follows
    // directly from reading the implementation, not from this assertion).
    const host = await store.signup("host-update-empty", "호스트", "pw1234");
    const [place] = await store.upsertPlaces([
      {
        id: "place-update-empty-a",
        naverPlaceId: "naver-update-empty-a",
        name: "다카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.4,
        longitude: 126.9,
        station: "홍대",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "CAFE", "QUIET");

    const updated = await store.updateUserPlace(host.user.id, hostPlace.id, "MEAL", "FUN", []);
    assert.equal(updated.purpose, "MEAL");
    assert.equal(updated.mood, "FUN");

    const [listed] = await store.listUserPlaces(host.user.id);
    assert.equal(listed!.purpose, "MEAL");
    assert.equal(listed!.mood, "FUN");
  });

  it("rejects updateUserPlace with USER_PLACE_NOT_FOUND for a nonexistent userPlaceId", async () => {
    const host = await store.signup("host-update-no-place", "호스트", "pw1234");

    await assert.rejects(
      () =>
        store.updateUserPlace(
          host.user.id,
          "00000000-0000-0000-0000-000000000000",
          "MEAL",
          "FUN",
          []
        ),
      (error: unknown) => (error as { code?: string }).code === "USER_PLACE_NOT_FOUND"
    );
  });

  it("rejects updateUserPlace with MEETING_NOT_FOUND when applyToMeetingIds names a nonexistent meeting", async () => {
    const host = await store.signup("host-update-no-meeting", "호스트", "pw1234");
    const [place] = await store.upsertPlaces([
      {
        id: "place-update-no-meeting-a",
        naverPlaceId: "naver-update-no-meeting-a",
        name: "라카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "CAFE", "QUIET");

    await assert.rejects(
      () =>
        store.updateUserPlace(
          host.user.id,
          hostPlace.id,
          "MEAL",
          "FUN",
          ["00000000-0000-0000-0000-000000000000"]
        ),
      (error: unknown) => (error as { code?: string }).code === "MEETING_NOT_FOUND"
    );
  });

  it("rolls back the whole updateUserPlace transaction (including the user_places row) when one of several meeting ids is invalid", async () => {
    const host = await store.signup("host-update-rollback", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "장소수정 롤백 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-update-rollback-a",
        naverPlaceId: "naver-update-rollback-a",
        name: "마카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    // meeting.id is a valid, RECRUITING meeting so it would be processed
    // successfully by the per-meeting loop; the second id does not exist.
    // Because the user_places row is updated before the per-meeting loop
    // even starts, a naive fix that only rolled back the loop's own work
    // (or didn't roll back at all) would still leave purpose/mood changed
    // to MEAL/FUN here even though the whole call rejected.
    await assert.rejects(
      () =>
        store.updateUserPlace(
          host.user.id,
          hostPlace.id,
          "MEAL",
          "FUN",
          [meeting.id, "ffffffff-ffff-ffff-ffff-ffffffffffff"]
        ),
      (error: unknown) => (error as { code?: string }).code === "MEETING_NOT_FOUND"
    );

    const [listed] = await store.listUserPlaces(host.user.id);
    assert.equal(listed!.purpose, "CAFE");
    assert.equal(listed!.mood, "QUIET");

    // The RECRUITING meeting's candidate should also be untouched: the
    // rollback must undo any per-meeting work done before the invalid id
    // was hit, not just leave user_places alone.
    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 1);
  });

  it("unregisters a user place and removes it from an active candidate when requested", async () => {
    const host = await store.signup("host-unregister-place", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "등록해제 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-unregister-a",
        naverPlaceId: "naver-unregister-a",
        name: "가호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const result = await store.unregisterUserPlace(host.user.id, hostPlace.id, true);
    assert.equal(result.unregistered, true);
    assert.equal(result.appliedToActiveMeetings, true);

    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 0);

    const places = await store.listUserPlaces(host.user.id);
    assert.equal(places.some((item) => item.id === hostPlace.id), false);
  });

  it("unregisters a user place with applyToActiveMeetings=false, leaving every meeting's candidates untouched", async () => {
    // This is the counterpart to the test above: with the flag off, the
    // method must still deactivate the user_places row, but it must not even
    // look up affected meetings (meetingIds stays []), so the per-meeting
    // delete loop never runs. We verify both the "still deactivated" half
    // and the "meeting truly untouched" half — including updated_at, not
    // just candidate count, since a bug that emptied meetingIds but still
    // bumped updated_at for some unrelated reason wouldn't be caught by
    // candidate count alone.
    const host = await store.signup("host-unregister-noapply", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "등록해제 미적용 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-unregister-noapply-a",
        naverPlaceId: "naver-unregister-noapply-a",
        name: "나호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const meetingBeforeUnregister = await store.detail(meeting.id, host.user.id);

    const result = await store.unregisterUserPlace(host.user.id, hostPlace.id, false);
    assert.equal(result.unregistered, true);
    assert.equal(result.appliedToActiveMeetings, false);

    // The user_places row is deactivated regardless of the flag.
    const places = await store.listUserPlaces(host.user.id);
    assert.equal(places.some((item) => item.id === hostPlace.id), false);

    // But the meeting's candidate — and the meeting row itself — must be
    // completely untouched.
    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 1);
    const meetingAfterUnregister = await store.detail(meeting.id, host.user.id);
    assert.equal(meetingAfterUnregister.updatedAt, meetingBeforeUnregister.updatedAt);
  });

  it("with applyToActiveMeetings=true, only touches RECRUITING meetings where the caller is still an ACTIVE member", async () => {
    // Three meetings exercise the three cases the affected-meeting SELECT
    // must distinguish:
    //   - meetingA: RECRUITING, host is ACTIVE  -> included, mutated.
    //   - meetingB: VOTING (not RECRUITING), host is ACTIVE -> excluded by
    //     the `m.status = 'RECRUITING'` filter.
    //   - meetingC: RECRUITING, but host's membership there is LEFT (not
    //     ACTIVE) -> excluded by the `member.status = 'ACTIVE'` join filter.
    // For meetingC specifically: if the ACTIVE-membership filter were ever
    // dropped from the SELECT, meetingC's id would land in meetingIds, and
    // the loop unconditionally runs `update meetings set updated_at = now()`
    // for every id in that list — regardless of whether the per-meeting
    // delete queries (which re-check member.status = 'ACTIVE' and therefore
    // wouldn't have deleted anything) found rows to remove. So checking
    // meetingC's updated_at is a direct probe of the SELECT's own filter,
    // not just of the delete queries' redundant guard.
    const host = await store.signup("host-unregister-multi", "호스트", "pw1234");
    const other = await store.signup("other-unregister-multi", "다른유저", "pw1234");

    const meetingA = await store.createMeeting(host.user.id, {
      name: "등록해제 다중 테스트 A",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const meetingB = await store.createMeeting(host.user.id, {
      name: "등록해제 다중 테스트 B",
      capacity: 2,
      meetingAt: "2026-08-02T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const meetingC = await store.createMeeting(other.user.id, {
      name: "등록해제 다중 테스트 C",
      capacity: 2,
      meetingAt: "2026-08-03T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-unregister-multi-a",
        naverPlaceId: "naver-unregister-multi-a",
        name: "다호프",
        category: "호프",
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
        id: "place-unregister-multi-b",
        naverPlaceId: "naver-unregister-multi-b",
        name: "라호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);

    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "DRINK", "TIPSY");
    const hostPlace2 = await store.registerUserPlace(host.user.id, placeB!.naverPlaceId, "DRINK", "TIPSY");

    // meetingA: only hostPlace, stays RECRUITING -> will be mutated.
    await store.replaceMyCandidates(meetingA.id, host.user.id, [hostPlace.id]);
    // meetingB: hostPlace + hostPlace2 (2 distinct candidates so createVote
    // succeeds), then moved to VOTING before the unregister call.
    await store.replaceMyCandidates(meetingB.id, host.user.id, [hostPlace.id, hostPlace2.id]);
    await store.createVote(meetingB.id, host.user.id);

    // meetingC: host joins as a regular member, adds hostPlace as their
    // candidate, then leaves — leaving RECRUITING intact but host's own
    // membership status LEFT (not ACTIVE).
    await store.joinMeeting(host.user.id, meetingC.id, meetingC.joinCode!, "호스트");
    await store.replaceMyCandidates(meetingC.id, host.user.id, [hostPlace.id]);
    await store.leaveMeeting(meetingC.id, host.user.id);

    const meetingABefore = await store.detail(meetingA.id, host.user.id);
    const meetingBBefore = await store.detail(meetingB.id, host.user.id);
    assert.equal(meetingBBefore.status, "VOTING");
    // host is no longer an ACTIVE member of meetingC, so detail() (which
    // only lists ACTIVE memberships) can't be called with host's id anymore;
    // query meetingC's state through its host ("other") instead, since
    // updated_at is a property of the meeting row, not of any one member.
    const meetingCBefore = await store.detail(meetingC.id, other.user.id);
    assert.equal(meetingCBefore.status, "RECRUITING");

    const result = await store.unregisterUserPlace(host.user.id, hostPlace.id, true);
    assert.equal(result.unregistered, true);
    assert.equal(result.appliedToActiveMeetings, true);

    // meetingA: mutated — candidate removed, updated_at bumped.
    const candidatesA = await store.publicCandidates(meetingA.id, host.user.id);
    assert.equal(candidatesA.length, 0);
    const meetingAAfter = await store.detail(meetingA.id, host.user.id);
    assert.notEqual(meetingAAfter.updatedAt, meetingABefore.updatedAt);

    // meetingB: untouched — both candidates remain, updated_at unchanged.
    const candidatesB = await store.publicCandidates(meetingB.id, host.user.id);
    assert.equal(candidatesB.length, 2);
    const meetingBAfter = await store.detail(meetingB.id, host.user.id);
    assert.equal(meetingBAfter.updatedAt, meetingBBefore.updatedAt);

    // meetingC: untouched — updated_at unchanged (checked via "other", the
    // still-ACTIVE host of meetingC).
    const meetingCAfter = await store.detail(meetingC.id, other.user.id);
    assert.equal(meetingCAfter.updatedAt, meetingCBefore.updatedAt);
  });

  it("rejects unregisterUserPlace with USER_PLACE_NOT_FOUND for a nonexistent userPlaceId", async () => {
    const host = await store.signup("host-unregister-no-place", "호스트", "pw1234");

    await assert.rejects(
      () => store.unregisterUserPlace(host.user.id, "00000000-0000-0000-0000-000000000000", false),
      (error: unknown) => (error as { code?: string }).code === "USER_PLACE_NOT_FOUND"
    );
    await assert.rejects(
      () => store.unregisterUserPlace(host.user.id, "00000000-0000-0000-0000-000000000000", true),
      (error: unknown) => (error as { code?: string }).code === "USER_PLACE_NOT_FOUND"
    );
  });

  it("rejects unregisterUserPlace with USER_PLACE_NOT_FOUND when the place is already inactive, and leaves an active meeting untouched", async () => {
    // Calling unregister twice (or on an already-unregistered place) should
    // fail the same way a truly nonexistent id would — the `is_active =
    // true` guard in the UPDATE means a second call finds no row. This also
    // doubles as a rollback-shape check: applyToActiveMeetings=true means
    // the meeting lock is taken and the meeting lookup runs before the
    // failing update, so we confirm the RECRUITING meeting's candidate and
    // updated_at survive the rejected call untouched.
    const host = await store.signup("host-unregister-twice", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "등록해제 재시도 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-unregister-twice-a",
        naverPlaceId: "naver-unregister-twice-a",
        name: "마호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "DRINK", "TIPSY");
    // A second, still-active place is what keeps meeting's candidate list
    // non-empty after the first unregister call below.
    const [place2] = await store.upsertPlaces([
      {
        id: "place-unregister-twice-b",
        naverPlaceId: "naver-unregister-twice-b",
        name: "바호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace2 = await store.registerUserPlace(host.user.id, place2!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id, hostPlace2.id]);

    await store.unregisterUserPlace(host.user.id, hostPlace.id, true);
    const meetingBefore = await store.detail(meeting.id, host.user.id);
    const candidatesBefore = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidatesBefore.length, 1);

    await assert.rejects(
      () => store.unregisterUserPlace(host.user.id, hostPlace.id, true),
      (error: unknown) => (error as { code?: string }).code === "USER_PLACE_NOT_FOUND"
    );

    const meetingAfter = await store.detail(meeting.id, host.user.id);
    const candidatesAfter = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidatesAfter.length, 1);
    assert.equal(meetingAfter.updatedAt, meetingBefore.updatedAt);
  });

  it("skips a meeting's candidate cleanup via the post-lock recheck when the meeting leaves RECRUITING while unregisterUserPlace is blocked on that meeting's advisory lock", async () => {
    // unregisterUserPlace's affected-meeting SELECT (RECRUITING + caller
    // ACTIVE) runs BEFORE any advisory lock is taken; the per-meeting
    // candidate/recommendation cleanup runs AFTER the lock. A meeting that
    // transitions out of RECRUITING in that window must be re-verified and
    // skipped, not blindly cleaned up (see postgres-store.ts, the recheck
    // query right before the per-meeting delete queries in
    // unregisterUserPlace).
    //
    // That window can't be produced by sequential calls within a single
    // connection — the initial SELECT and the recheck would always see the
    // same committed state. So this test drives real Postgres concurrency:
    // a second raw connection holds the meeting's advisory lock *before*
    // unregisterUserPlace starts, forcing the store's own lock-acquisition
    // loop to block after its SELECT has already found the meeting RECRUITING.
    // While blocked, the second connection flips the meeting to VOTING and
    // releases the lock by committing — so when unregisterUserPlace finally
    // acquires the lock and runs its recheck, it must see VOTING and skip.
    const host = await store.signup("host-unregister-race", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "등록해제 경합 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-unregister-race-a",
        naverPlaceId: "naver-unregister-race-a",
        name: "사호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const meetingBefore = await store.detail(meeting.id, host.user.id);
    assert.equal(meetingBefore.status, "RECRUITING");

    const blocker = new Client({ connectionString: testDatabaseUrl });
    await blocker.connect();
    try {
      await blocker.query("begin");
      // Same lock key/derivation as the store's own
      // `pg_advisory_xact_lock(hashtext('meeting:' + id))` calls.
      await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [`meeting:${meeting.id}`]);

      const unregisterPromise = store.unregisterUserPlace(host.user.id, hostPlace.id, true);

      // There's no clean signal for "the store's lock-acquisition query is
      // now waiting on Postgres" from outside — a short delay is the
      // pragmatic way to let unregisterUserPlace's initial SELECT (which
      // finds the meeting RECRUITING) and its lock attempt actually run and
      // block before we mutate state out from under it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      await blocker.query(`update meetings set status = 'VOTING', updated_at = now() where id = $1`, [
        meeting.id
      ]);
      await blocker.query("commit");

      const result = await unregisterPromise;
      assert.equal(result.unregistered, true);
      assert.equal(result.appliedToActiveMeetings, true);
    } finally {
      await blocker.end();
    }

    // The user_places row is deactivated regardless of the meeting's status
    // — that update happens before the per-meeting loop and doesn't depend
    // on the recheck.
    const places = await store.listUserPlaces(host.user.id);
    assert.equal(places.some((item) => item.id === hostPlace.id), false);

    // But the candidate cleanup for `meeting` must have been skipped by the
    // post-lock recheck: the candidate the user solely recommended is still
    // there, because the meeting was no longer RECRUITING by the time the
    // recheck ran, even though it was RECRUITING (and included in
    // meetingIds) when the initial SELECT ran.
    const candidatesAfter = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidatesAfter.length, 1);

    const meetingAfter = await store.detail(meeting.id, host.user.id);
    assert.equal(meetingAfter.status, "VOTING");
  });

  it("repeatMeeting creates a RECRUITING next meeting sharing the join code, and rejects every invalid call", async () => {
    const host = await store.signup("host-repeat", "호스트", "pw1234");
    const guest = await store.signup("guest-repeat", "게스트", "pw1234");
    const meetingA = await store.createMeeting(host.user.id, {
      name: "다시 만나기 1회차",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meetingA.id, meetingA.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-repeat-a",
        naverPlaceId: "naver-repeat-a",
        name: "가카페",
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
        id: "place-repeat-b",
        naverPlaceId: "naver-repeat-b",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "CAFE", "QUIET");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meetingA.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meetingA.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meetingA.id, host.user.id);

    const hostSession = await store.voteSession(meetingA.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meetingA.id, host.user.id, 1, hostChoiceId);

    // --- MEETING_NOT_COMPLETED: meetingA is still VOTING (the guest hasn't
    // saved their choice yet), so repeatMeeting must reject before checking
    // anything about member selection. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 2회차",
          capacity: 5,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: []
        }),
      (error: unknown) => (error as { code?: string }).code === "MEETING_NOT_COMPLETED"
    );

    const guestSession = await store.voteSession(meetingA.id, guest.user.id);
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateA.id
        : guestSession.round!.candidateB.id;
    await store.saveChoice(meetingA.id, guest.user.id, 1, guestChoiceId);

    const closeResults = await store.closeVote(meetingA.id, host.user.id, false);
    assert.equal(closeResults.meetingStatus, "COMPLETED");

    const detailA = await store.detail(meetingA.id, host.user.id);
    const hostMemberA = detailA.members.find((member) => member.role === "HOST")!;
    const guestMemberA = detailA.members.find((member) => member.role === "MEMBER")!;

    // --- HOST_ONLY: the guest is not the host of meetingA. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, guest.user.id, {
          name: "다시 만나기 2회차",
          capacity: 5,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id, guestMemberA.id]
        }),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    // --- HOST_MEMBER_REQUIRED: memberIds excludes the host. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 2회차",
          capacity: 5,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [guestMemberA.id]
        }),
      (error: unknown) => (error as { code?: string }).code === "HOST_MEMBER_REQUIRED"
    );

    // --- INVALID_MEMBER_SELECTION: memberIds includes an id that was never
    // an active member of meetingA. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 2회차",
          capacity: 5,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id, "00000000-0000-0000-0000-000000000000"]
        }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_MEMBER_SELECTION"
    );

    // --- CAPACITY_TOO_SMALL: two members selected, capacity of 1. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 2회차",
          capacity: 1,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id, guestMemberA.id]
        }),
      (error: unknown) => (error as { code?: string }).code === "CAPACITY_TOO_SMALL"
    );

    // --- INVALID_CUSTOM_RECURRENCE_DATE: the custom next-meeting date isn't
    // after the new meeting's own meetingAt. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 2회차",
          capacity: 5,
          meetingAt: "2026-08-08T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id, guestMemberA.id],
          recurrence: { type: "CUSTOM", customNextMeetingAt: "2026-08-08T10:00:00+09:00" }
        }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_CUSTOM_RECURRENCE_DATE"
    );

    // --- The actual successful repeat: both members selected, no recurrence. ---
    const meetingB = await store.repeatMeeting(meetingA.id, host.user.id, {
      name: "다시 만나기 2회차",
      capacity: 5,
      meetingAt: "2026-08-08T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET",
      memberIds: [hostMemberA.id, guestMemberA.id]
    });
    assert.equal(meetingB.status, "RECRUITING");
    assert.equal(meetingB.joinCode, meetingA.joinCode);
    assert.equal(meetingB.parentMeetingId, meetingA.id);
    assert.equal(meetingB.members.length, 2);
    assert.ok(meetingB.members.every((member) => member.status === "ACTIVE"));
    const hostMemberB = meetingB.members.find((member) => member.role === "HOST")!;
    const guestMemberB = meetingB.members.find((member) => member.role === "MEMBER")!;
    assert.equal(hostMemberB.userId, host.user.id);
    assert.equal(guestMemberB.userId, guest.user.id);

    // --- NEXT_MEETING_ALREADY_EXISTS: meetingA already has a next meeting
    // now (meetingB), so repeating it again must be rejected. ---
    await assert.rejects(
      () =>
        store.repeatMeeting(meetingA.id, host.user.id, {
          name: "다시 만나기 3회차",
          capacity: 5,
          meetingAt: "2026-08-15T10:00:00+09:00",
          purpose: "CAFE",
          mood: "QUIET",
          memberIds: [hostMemberA.id, guestMemberA.id]
        }),
      (error: unknown) => (error as { code?: string }).code === "NEXT_MEETING_ALREADY_EXISTS"
    );
  });
});
