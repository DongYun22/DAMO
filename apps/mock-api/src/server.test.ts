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
