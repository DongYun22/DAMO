import { createHash } from "node:crypto";
import type { Place } from "@damo/contracts";

interface NaverLocalSearchItem {
  title: string;
  link: string;
  category: string;
  description: string;
  telephone: string;
  address: string;
  roadAddress: string;
  mapx: string;
  mapy: string;
}

interface NaverLocalSearchResponse {
  items: NaverLocalSearchItem[];
}

export interface NaverSearchCredentials {
  clientId: string;
  clientSecret: string;
}

type Fetcher = typeof fetch;

const decodeText = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

const coordinate = (value: string, limit: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return Math.abs(parsed) > limit ? parsed / 10_000_000 : parsed;
};

const placeIdentity = (item: NaverLocalSearchItem) => {
  const linkedPlaceId =
    item.link.match(/\/place\/(\d+)/)?.[1] ??
    item.link.match(/[?&](?:id|placeId)=(\d+)/)?.[1];
  if (linkedPlaceId) return linkedPlaceId;

  return createHash("sha256")
    .update([decodeText(item.title), item.roadAddress, item.address, item.mapx, item.mapy].join("|"))
    .digest("hex")
    .slice(0, 20);
};

const toPlace = (item: NaverLocalSearchItem, query: string): Place => {
  const identity = placeIdentity(item);
  return {
    id: `place-naver-${identity}`,
    naverPlaceId: `naver-${identity}`,
    name: decodeText(item.title),
    category: decodeText(item.category).replace(/>/g, " · "),
    address: decodeText(item.address),
    roadAddress: decodeText(item.roadAddress || item.address),
    latitude: coordinate(item.mapy, 90),
    longitude: coordinate(item.mapx, 180),
    station: query.trim().endsWith("역") ? query.trim() : "",
    distanceText: "지도에서 위치 확인"
  };
};

export const naverSearchCredentials = (): NaverSearchCredentials | null => {
  const clientId = process.env.NAVER_SEARCH_CLIENT_ID?.trim();
  const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

export async function searchNaverLocalPlaces(
  query: string,
  credentials: NaverSearchCredentials,
  fetcher: Fetcher = fetch
): Promise<Place[]> {
  const url = new URL("https://openapi.naver.com/v1/search/local.json");
  url.searchParams.set("query", query);
  url.searchParams.set("display", "5");
  url.searchParams.set("start", "1");
  url.searchParams.set("sort", "random");

  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      "X-Naver-Client-Id": credentials.clientId,
      "X-Naver-Client-Secret": credentials.clientSecret
    },
    signal: AbortSignal.timeout(6_000)
  });

  if (!response.ok) {
    throw new Error(`NAVER_LOCAL_SEARCH_${response.status}`);
  }

  const body = (await response.json()) as NaverLocalSearchResponse;
  return (body.items ?? [])
    .map((item) => toPlace(item, query))
    .filter(
      (place) =>
        place.name.length > 0 &&
        Number.isFinite(place.latitude) &&
        Number.isFinite(place.longitude) &&
        place.latitude >= -90 &&
        place.latitude <= 90 &&
        place.longitude >= -180 &&
        place.longitude <= 180
    );
}
