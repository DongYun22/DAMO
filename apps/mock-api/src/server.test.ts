import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Place } from "@damo/contracts";
import { app } from "./server.js";
import { store } from "./app-store.js";

let baseUrl = "";
const server = app.listen(0, "127.0.0.1");

before(async () => {
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

const request = async (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer mock-token-user-1",
      ...init.headers
    }
  });

describe("DAMO mock API", () => {
  it("returns seeded home sections and vote alert", async () => {
    await store.reset();
    const response = await request("/api/v1/me/home");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.ongoingMeetings.length, 2);
    assert.equal(body.data.completedMeetings.length, 1);
    assert.equal(body.data.hasVoteAlert, true);
  });

  it("creates a meeting and enforces minimum capacity", async () => {
    await store.reset();
    const invalid = await request("/api/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        name: "작은 모임",
        capacity: 1,
        meetingAt: "2026-08-20T10:00:00+09:00",
        purpose: "CAFE",
        mood: "QUIET"
      })
    });
    assert.equal(invalid.status, 400);

    const valid = await request("/api/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        name: "새 카페 모임",
        capacity: 4,
        meetingAt: "2026-08-20T10:30:00+09:00",
        purpose: "CAFE",
        mood: "QUIET"
      })
    });
    assert.equal(valid.status, 201);
    const body = await valid.json();
    assert.match(body.data.joinCode, /^\d{4}$/);
    assert.notEqual(body.data.joinCode, "4821");
    assert.notEqual(body.data.joinCode, "7314");
    assert.equal(body.data.role, "HOST");

    const another = await request("/api/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        name: "두 번째 모임",
        capacity: 2,
        meetingAt: "2026-08-20T11:00:00+09:00",
        purpose: "STUDY",
        mood: "BUSINESS"
      })
    });
    const anotherBody = await another.json();
    assert.notEqual(anotherBody.data.joinCode, body.data.joinCode);
  });

  it("blocks a KICKED member from rejoining a meeting via join code", async () => {
    await store.reset();
    const created = await request("/api/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        name: "강퇴 재입장 테스트",
        capacity: 4,
        meetingAt: "2026-08-20T10:00:00+09:00",
        purpose: "CAFE",
        mood: "QUIET"
      })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const meetingId = createdBody.data.id;
    const joinCode = createdBody.data.joinCode;

    const joined = await request(`/api/v1/meetings/${meetingId}/join`, {
      method: "POST",
      headers: { authorization: "Bearer mock-token-user-2" },
      body: JSON.stringify({ joinCode, meetingNickname: "게스트닉" })
    });
    assert.equal(joined.status, 200);

    const detail = await request(`/api/v1/meetings/${meetingId}`);
    const detailBody = await detail.json();
    const guestMember = detailBody.data.members.find(
      (member: { userId: string }) => member.userId === "user-2"
    );
    assert.ok(guestMember);

    const kicked = await request(
      `/api/v1/meetings/${meetingId}/members/${guestMember.id}/kick`,
      { method: "POST" }
    );
    assert.equal(kicked.status, 200);

    // Plenty of room remains (capacity 4, only the host left), but a KICKED
    // member must never be allowed to walk back in with the join code.
    const rejoin = await request(`/api/v1/meetings/${meetingId}/join`, {
      method: "POST",
      headers: { authorization: "Bearer mock-token-user-2" },
      body: JSON.stringify({ joinCode, meetingNickname: "게스트닉2" })
    });
    assert.equal(rejoin.status, 403);
    const rejoinBody = await rejoin.json();
    assert.equal(rejoinBody.error.code, "PREVIOUSLY_KICKED");
  });

  it("archives a past-due meeting in the completed home section without changing its status", async () => {
    await store.reset();
    const created = await request("/api/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        name: "지난 일정",
        capacity: 2,
        meetingAt: "2026-07-01T19:00:00+09:00",
        purpose: "MEAL",
        mood: "QUIET"
      })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();

    const home = await request("/api/v1/me/home");
    const homeBody = await home.json();
    const archived = homeBody.data.completedMeetings.find(
      (meeting: { id: string }) => meeting.id === createdBody.data.id
    );
    assert.equal(archived.status, "RECRUITING");
    assert.equal(archived.isPastDue, true);
    assert.equal(
      homeBody.data.ongoingMeetings.some(
        (meeting: { id: string }) => meeting.id === createdBody.data.id
      ),
      false
    );
  });

  it("creates a new meeting round with the same code and selected previous members", async () => {
    await store.reset();
    const response = await request("/api/v1/meetings/meeting-3/repeat", {
      method: "POST",
      headers: { authorization: "Bearer mock-token-user-3" },
      body: JSON.stringify({
        name: "주말 카페 투어",
        capacity: 4,
        meetingAt: "2026-08-03T13:30:00+09:00",
        purpose: "CAFE",
        mood: "FUN",
        memberIds: ["member-31", "member-32"],
        recurrence: { type: "WEEKLY" }
      })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.joinCode, "1208");
    assert.equal(body.data.parentMeetingId, "meeting-3");
    assert.equal(body.data.recurrence.type, "WEEKLY");
    assert.deepEqual(
      body.data.members.map((member: { userId: string }) => member.userId).sort(),
      ["user-1", "user-3"]
    );

    const previous = await request("/api/v1/meetings/meeting-3", {
      headers: { authorization: "Bearer mock-token-user-3" }
    });
    const previousBody = await previous.json();
    assert.equal(previousBody.data.status, "COMPLETED");

    await request(`/api/v1/meetings/${body.data.id}/candidates/me`, {
      method: "PUT",
      headers: { authorization: "Bearer mock-token-user-3" },
      body: JSON.stringify({ userPlaceIds: ["up-9"] })
    });
    const candidatesResponse = await request(
      `/api/v1/meetings/${body.data.id}/candidates/me`,
      {
        method: "PUT",
        body: JSON.stringify({ userPlaceIds: ["up-1"] })
      }
    );
    const candidatesBody = await candidatesResponse.json();
    const selectedCandidateId = candidatesBody.data[0].id;

    await request(`/api/v1/meetings/${body.data.id}/vote`, {
      method: "POST",
      headers: { authorization: "Bearer mock-token-user-3" },
      body: "{}"
    });
    for (const accessToken of ["mock-token-user-3", "mock-token-user-1"]) {
      const sessionResponse = await request(
        `/api/v1/meetings/${body.data.id}/vote/session`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      );
      const sessionBody = await sessionResponse.json();
      await request(`/api/v1/meetings/${body.data.id}/vote/choices`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          roundNumber: sessionBody.data.round.roundNumber,
          selectedCandidateId
        })
      });
    }
    const closed = await request(
      `/api/v1/meetings/${body.data.id}/vote/close`,
      {
        method: "POST",
        headers: { authorization: "Bearer mock-token-user-3" },
        body: JSON.stringify({ force: false })
      }
    );
    assert.equal(closed.status, 200);

    const home = await request("/api/v1/me/home", {
      headers: { authorization: "Bearer mock-token-user-3" }
    });
    const homeBody = await home.json();
    const nextOccurrence = homeBody.data.ongoingMeetings.find(
      (meeting: { parentMeetingId: string }) =>
        meeting.parentMeetingId === body.data.id
    );
    assert.equal(nextOccurrence.joinCode, "1208");
    assert.equal(nextOccurrence.meetingAt, "2026-08-10T04:30:00.000Z");
  });

  it("registers a searched NAVER place and returns it from My Places", async () => {
    await store.reset();
    const searchedPlace: Place = {
      id: "place-naver-98765",
      naverPlaceId: "naver-98765",
      name: "테스트 네이버 카페",
      category: "카페 · 디저트",
      address: "서울특별시 성동구 성수동 2가",
      roadAddress: "서울특별시 성동구 성수이로 20",
      latitude: 37.544,
      longitude: 127.056,
      station: "성수역",
      distanceText: "지도에서 위치 확인"
    };
    store.upsertPlaces([searchedPlace]);

    const registered = await request("/api/v1/me/places", {
      method: "POST",
      body: JSON.stringify({
        naverPlaceId: searchedPlace.naverPlaceId,
        purpose: "CAFE",
        mood: "QUIET"
      })
    });
    assert.equal(registered.status, 201);

    const list = await request("/api/v1/me/places");
    const body = await list.json();
    assert.equal(
      body.data.some(
        (item: { place: Place }) => item.place.naverPlaceId === searchedPlace.naverPlaceId
      ),
      true
    );
  });

  it("shows every My Place ordered by meeting match and allows a mismatch", async () => {
    await store.reset();
    const response = await request(
      "/api/v1/meetings/meeting-1/eligible-places"
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map(
        (item: { place: Place; matchCount: number }) => [
          item.place.name,
          item.matchCount
        ]
      ),
      [
        ["서울숲 피자클럽", 2],
        ["오후의 테라스", 1],
        ["호호식당 성수", 1],
        ["커먼 라운지", 0],
        ["페이지 스터디라운지", 0]
      ]
    );

    const selected = await request(
      "/api/v1/meetings/meeting-1/candidates/me",
      {
        method: "PUT",
        body: JSON.stringify({ userPlaceIds: ["up-4"] })
      }
    );
    assert.equal(selected.status, 200);
    const selectedBody = await selected.json();
    assert.equal(
      selectedBody.data.some(
        (candidate: { place: Place; recommendedByMe: boolean }) =>
          candidate.place.id === "place-4" && candidate.recommendedByMe
      ),
      true
    );
  });

  it("keeps a selected candidate when its purpose and mood no longer match", async () => {
    await store.reset();
    const updated = await request("/api/v1/me/places/up-2", {
      method: "PATCH",
      body: JSON.stringify({
        purpose: "STUDY",
        mood: "BUSINESS",
        applyToMeetingIds: ["meeting-1"]
      })
    });
    assert.equal(updated.status, 200);

    const candidates = await request(
      "/api/v1/meetings/meeting-1/candidates"
    );
    const body = await candidates.json();
    assert.equal(
      body.data.some(
        (candidate: { place: Place; recommendedByMe: boolean }) =>
          candidate.place.id === "place-2" && candidate.recommendedByMe
      ),
      true
    );
  });

  it("runs the current user's N-1 vote and removes the alert", async () => {
    await store.reset();
    const first = await request("/api/v1/meetings/meeting-2/vote/session");
    const firstBody = await first.json();
    assert.equal(firstBody.data.totalRounds, 2);

    const round1 = firstBody.data.round;
    await request("/api/v1/meetings/meeting-2/vote/choices", {
      method: "POST",
      body: JSON.stringify({
        roundNumber: round1.roundNumber,
        selectedCandidateId: round1.candidateA.id
      })
    });

    const second = await request("/api/v1/meetings/meeting-2/vote/session");
    const secondBody = await second.json();
    const round2 = secondBody.data.round;
    const completed = await request("/api/v1/meetings/meeting-2/vote/choices", {
      method: "POST",
      body: JSON.stringify({
        roundNumber: round2.roundNumber,
        selectedCandidateId: round2.candidateB.id
      })
    });
    const completedBody = await completed.json();
    assert.equal(completedBody.data.status, "COMPLETED");

    const home = await request("/api/v1/me/home");
    const homeBody = await home.json();
    assert.equal(homeBody.data.hasVoteAlert, false);
  });
});
