import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchNaverLocalPlaces } from "./naver-search.js";

describe("NAVER local search adapter", () => {
  it("sends server credentials and converts a result to the DAMO place model", async () => {
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          items: [
            {
              title: "<b>다모</b> 카페",
              link: "https://map.naver.com/p/entry/place/123456",
              category: "카페>디저트",
              description: "",
              telephone: "",
              address: "서울특별시 성동구 성수동 1-1",
              roadAddress: "서울특별시 성동구 성수이로 10",
              mapx: "1270551234",
              mapy: "375441234"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const result = await searchNaverLocalPlaces(
      "성수역",
      { clientId: "client-id", clientSecret: "client-secret" },
      fakeFetch
    );

    assert.match(requestedUrl, /openapi\.naver\.com\/v1\/search\/local\.json/);
    assert.equal(requestedHeaders?.get("X-Naver-Client-Id"), "client-id");
    assert.equal(requestedHeaders?.get("X-Naver-Client-Secret"), "client-secret");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      id: "place-naver-123456",
      naverPlaceId: "naver-123456",
      name: "다모 카페",
      category: "카페 · 디저트",
      address: "서울특별시 성동구 성수동 1-1",
      roadAddress: "서울특별시 성동구 성수이로 10",
      latitude: 37.5441234,
      longitude: 127.0551234,
      station: "성수역",
      distanceText: "지도에서 위치 확인"
    });
  });
});
