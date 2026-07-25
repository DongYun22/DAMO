# DAMO API 명세

## 1. 문서 목적

이 문서는 DAMO 모바일 웹 프론트엔드와 백엔드가 주고받는 HTTP API를 정의한다.

- 사용자 흐름은 `flow.md`를 기준으로 한다.
- 데이터 구조와 상태 규칙은 `data-model.md`를 기준으로 한다.
- MVP API 기본 경로는 `/api/v1`이다.
- 요청과 응답 본문은 JSON을 사용한다.
- 네이버 지도 화면을 제외한 보호 API는 로그인이 필요하다.
- MVP의 홈 상태와 투표 결과는 5초 간격 조회 방식으로 갱신한다.

## 2. 공통 규칙

### 2.1 기본 URL

개발 환경:

```text
https://dev.damo.com/api/v1
```

운영 환경:

```text
https://damo.com/api/v1
```

실제 도메인이 확정되기 전까지는 환경변수 `API_BASE_URL`로 관리한다.

### 2.2 인증

- 로그인 성공 시 서버가 Access Token과 Refresh Token을 쿠키로 발급한다.
- 쿠키는 `HttpOnly`, `Secure`, `SameSite=Lax`를 사용한다.
- 프론트엔드는 토큰 값을 JavaScript 저장소에 직접 보관하지 않는다.
- 프론트엔드는 API 호출 시 쿠키가 포함되도록 `credentials: "include"`를 사용한다.
- 상태를 변경하는 요청에서 서버는 `Origin` 헤더가 DAMO 도메인인지 검사한다.
- Access Token이 만료되면 Refresh API를 한 번 호출한 뒤 원래 요청을 재시도한다.

예:

```javascript
fetch(`${API_BASE_URL}/me`, {
  credentials: "include"
});
```

### 2.3 날짜와 시각

- API에서는 ISO 8601 문자열을 사용한다.
- 모임 시각은 `Asia/Seoul` 기준 오프셋을 포함해 전송한다.

```json
{
  "startsAt": "2026-07-29T19:30:00+09:00"
}
```

- 화면 입력은 오전/오후, `1~12시`, `00/30분`으로 제한한다.
- 서버도 분이 `00` 또는 `30`인지 다시 검사한다.

### 2.4 문자열 길이

| 필드 | 제한 |
| --- | --- |
| 모임 이름 | 1~20글자 |
| 계정 닉네임 | 1~20글자 |
| 모임 닉네임 | 1~20글자 |
| 테스트 로그인 아이디 | 4~50자 |
| 테스트 비밀번호 | 8~72자 |

글자 수는 바이트 수가 아니라 사용자가 인식하는 문자 수를 기준으로 검사한다.

### 2.5 열거형

목적:

```text
STUDY | CAFE | MEAL | DRINK
```

성격:

```text
FUN | QUIET | BUSINESS | TIPSY
```

모임 상태:

```text
RECRUITING | VOTING | FINAL_SELECTION | COMPLETED | DELETED
```

참여자 역할:

```text
HOST | MEMBER
```

참여자 상태:

```text
ACTIVE | LEFT | KICKED
```

개인 투표 상태:

```text
NOT_STARTED | IN_PROGRESS | COMPLETED
```

### 2.6 성공 응답

단일 데이터:

```json
{
  "data": {
    "id": "0a68bc4d-2dc7-4ad0-8cc3-f56cb9c45d33"
  }
}
```

목록 데이터:

```json
{
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

### 2.7 오류 응답

모든 오류는 같은 구조를 사용한다.

```json
{
  "error": {
    "code": "MEETING_FULL",
    "message": "정원이 모두 찼습니다.",
    "details": {
      "capacity": 6,
      "currentMemberCount": 6
    },
    "requestId": "req_01J..."
  }
}
```

| HTTP 상태 | 사용 상황 |
| --- | --- |
| `400` | 요청 형식 또는 입력값 오류 |
| `401` | 로그인 필요 또는 세션 만료 |
| `403` | 권한 없음 |
| `404` | 데이터 없음 또는 삭제됨 |
| `409` | 현재 상태와 요청이 충돌 |
| `422` | 형식은 맞지만 운영 규칙 위반 |
| `429` | 요청 횟수 제한 초과 |
| `500` | 서버 내부 오류 |

### 2.8 목록 조회

- 기본 조회 개수는 20개다.
- `limit` 최댓값은 100개다.
- 추가 목록은 `cursor`를 사용한다.

```http
GET /api/v1/me/places?limit=20&cursor={nextCursor}
```

## 3. API 전체 목록

### 3.1 인증과 사용자

| Method | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/auth/test/signup` | 테스트 계정 즉시 가입 |
| `POST` | `/auth/test/login` | 테스트 계정 로그인 |
| `GET` | `/auth/oauth/{provider}` | OAuth 로그인 시작 |
| `GET` | `/auth/oauth/{provider}/callback` | OAuth 서버 콜백 |
| `POST` | `/auth/refresh` | 로그인 세션 갱신 |
| `POST` | `/auth/logout` | 로그아웃 |
| `GET` | `/me` | 내 계정 정보 |

### 3.2 홈과 모임

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/me/home` | 진행 중·완료 모임 목록 |
| `POST` | `/meetings` | 모임 생성 |
| `POST` | `/meetings/lookup` | 4자리 코드로 모임 확인 |
| `GET` | `/meetings/{meetingId}` | 모임 상세 조회 |
| `POST` | `/meetings/{meetingId}/join` | 모임 가입 또는 재가입 |
| `POST` | `/meetings/{meetingId}/leave` | 모임 탈퇴 |
| `DELETE` | `/meetings/{meetingId}` | 모임 삭제 |
| `POST` | `/meetings/{meetingId}/members/{memberId}/kick` | 모임원 내보내기 |

### 3.3 지도와 내 장소

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/map/places/search` | 역 또는 장소 검색 |
| `GET` | `/map/places/{naverPlaceId}` | 장소 상세 조회 |
| `GET` | `/me/places` | 내 장소 목록 |
| `POST` | `/me/places` | 내 장소 등록 |
| `PATCH` | `/me/places/{userPlaceId}` | 내 장소 분류 변경 |
| `POST` | `/me/places/{userPlaceId}/unregister` | 내 장소 등록 해제 |

### 3.4 후보

| Method | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/meetings/{meetingId}/eligible-places` | 후보로 선택 가능한 내 장소 |
| `GET` | `/meetings/{meetingId}/candidates` | 통합 후보 목록 |
| `PUT` | `/meetings/{meetingId}/candidates/me` | 내 후보 0~2개 교체 |

### 3.5 투표

| Method | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/meetings/{meetingId}/vote` | 투표 생성 |
| `GET` | `/meetings/{meetingId}/vote/session` | 내 현재 A/B 라운드 |
| `POST` | `/meetings/{meetingId}/vote/choices` | A/B 선택 저장 |
| `GET` | `/meetings/{meetingId}/vote/results` | 실시간 결과 |
| `POST` | `/meetings/{meetingId}/vote/close` | 모임장 수동 종료 |
| `POST` | `/meetings/{meetingId}/vote/final-selection` | 공동 1위 최종 선택 |

## 4. 인증과 사용자 API

### 4.1 테스트 계정 즉시 가입

배포 이전 테스트 환경에서만 활성화한다.

```http
POST /api/v1/auth/test/signup
```

요청:

```json
{
  "loginId": "damo_test",
  "nickname": "다모",
  "password": "test-password"
}
```

응답 `201 Created`:

```json
{
  "data": {
    "user": {
      "id": "user-uuid",
      "provider": "TEST",
      "nickname": "다모",
      "email": null
    },
    "redirectTo": "/"
  }
}
```

오류:

| 코드 | 상황 |
| --- | --- |
| `TEST_AUTH_DISABLED` | 운영 환경에서 테스트 가입 요청 |
| `LOGIN_ID_ALREADY_EXISTS` | 이미 사용 중인 아이디 |
| `INVALID_NICKNAME` | 닉네임 길이 또는 형식 오류 |
| `WEAK_PASSWORD` | 비밀번호 정책 불충족 |

### 4.2 테스트 계정 로그인

```http
POST /api/v1/auth/test/login
```

```json
{
  "loginId": "damo_test",
  "password": "test-password"
}
```

성공 시 인증 쿠키를 발급하고 홈으로 이동한다.

```json
{
  "data": {
    "redirectTo": "/"
  }
}
```

### 4.3 OAuth 로그인

지원 제공자:

```text
kakao | naver | google
```

로그인 시작:

```http
GET /api/v1/auth/oauth/kakao
```

- 서버가 OAuth 제공자의 인증 화면으로 리다이렉트한다.
- 콜백에서 제공자 사용자 ID, 닉네임, 이메일을 확인한다.
- 같은 이메일이 있어도 다른 제공자 계정과 자동 통합하지 않는다.
- 인증 쿠키를 발급한 뒤 DAMO 홈 `/`으로 리다이렉트한다.
- 초대 링크에서 시작했더라도 OAuth 완료 후에는 홈으로 이동한다.

OAuth 콜백은 프론트엔드가 직접 호출하지 않는다.

### 4.4 세션 갱신

```http
POST /api/v1/auth/refresh
```

- 유효한 Refresh Token 쿠키가 있으면 Access Token 쿠키를 다시 발급한다.
- 실패하면 `401 SESSION_EXPIRED`를 반환하고 로그인 화면으로 이동한다.

### 4.5 로그아웃

```http
POST /api/v1/auth/logout
```

응답 `204 No Content`.

### 4.6 내 계정 정보

```http
GET /api/v1/me
```

```json
{
  "data": {
    "id": "user-uuid",
    "provider": "KAKAO",
    "nickname": "다모",
    "email": "user@example.com"
  }
}
```

## 5. 홈 API

### 5.1 홈 데이터 조회

```http
GET /api/v1/me/home
```

응답:

```json
{
  "data": {
    "activeMeetings": [
      {
        "id": "meeting-uuid",
        "name": "7/29 파티룸",
        "role": "MEMBER",
        "status": "VOTING",
        "purpose": "DRINK",
        "mood": "FUN",
        "startsAt": "2026-07-29T19:30:00+09:00",
        "currentMemberCount": 4,
        "capacity": 6,
        "voteRequired": true,
        "showVoteAlert": true
      }
    ],
    "completedMeetings": [
      {
        "id": "completed-meeting-uuid",
        "name": "금요일 스터디",
        "role": "HOST",
        "status": "COMPLETED",
        "startsAt": "2026-07-18T14:00:00+09:00",
        "finalPlace": {
          "candidateId": "candidate-uuid",
          "name": "잔잔한 오후"
        },
        "displayTone": "MUTED"
      }
    ],
    "hasHomeNotification": true,
    "updatedAt": "2026-07-25T20:30:00+09:00",
    "pollAfterMs": 5000
  }
}
```

프론트엔드 처리:

- `activeMeetings`를 홈 상단에 표시한다.
- `completedMeetings`를 홈 하단에 더 연한 카드로 표시한다.
- `showVoteAlert = true`이면 분홍색 카드 강조와 홈 빨간 점을 표시한다.
- 화면이 보이는 동안 5초마다 다시 조회한다.
- 브라우저가 백그라운드 상태이면 조회를 중단하고 복귀 즉시 다시 조회한다.

## 6. 지도와 내 장소 API

### 6.1 장소 검색

```http
GET /api/v1/map/places/search?query=을지로3가역&latitude=37.566&longitude=126.991
```

응답:

```json
{
  "data": {
    "items": [
      {
        "naverPlaceId": "naver-place-123",
        "name": "을지로 보석",
        "category": "한식",
        "roadAddress": "서울 중구 수표로 48",
        "latitude": 37.5661,
        "longitude": 126.9912,
        "isSaved": true,
        "userPlaceId": "user-place-uuid"
      }
    ]
  }
}
```

- 네이버 API 비밀키가 필요한 호출은 백엔드에서 처리한다.
- 검색 결과에는 현재 사용자의 저장 여부를 함께 반환한다.

### 6.2 장소 상세

```http
GET /api/v1/map/places/{naverPlaceId}
```

장소명, 주소, 카테고리, 좌표, 저장 여부를 반환한다.

### 6.3 내 장소 목록

```http
GET /api/v1/me/places?purpose=MEAL&mood=FUN&limit=20
```

```json
{
  "data": {
    "items": [
      {
        "id": "user-place-uuid",
        "place": {
          "naverPlaceId": "naver-place-123",
          "name": "을지로 보석",
          "category": "한식",
          "roadAddress": "서울 중구 수표로 48"
        },
        "purpose": "MEAL",
        "mood": "FUN",
        "usedByRecruitingMeetings": [
          {
            "meetingId": "meeting-uuid",
            "meetingName": "7/29 파티룸"
          }
        ]
      }
    ],
    "nextCursor": null
  }
}
```

### 6.4 내 장소 등록

```http
POST /api/v1/me/places
```

```json
{
  "naverPlaceId": "naver-place-123",
  "purpose": "MEAL",
  "mood": "FUN"
}
```

응답 `201 Created`.

같은 사용자가 이미 저장한 장소라면 `409 USER_PLACE_ALREADY_SAVED`를 반환한다.

### 6.5 내 장소 변경

```http
PATCH /api/v1/me/places/{userPlaceId}
```

```json
{
  "purpose": "DRINK",
  "mood": "TIPSY",
  "applyToMeetingIds": [
    "meeting-uuid"
  ]
}
```

- `applyToMeetingIds`가 비어 있으면 `내 장소만 변경`이다.
- 배열에 포함된 모임은 `이번 투표에도 반영` 대상이다.
- `RECRUITING` 상태의 모임만 지정할 수 있다.
- 변경 후 목적과 성격이 모두 불일치하면 해당 사용자의 추천을 제거한다.
- 투표가 생성된 모임을 지정하면 `409 CANDIDATES_ALREADY_FROZEN`을 반환한다.

응답:

```json
{
  "data": {
    "userPlace": {
      "id": "user-place-uuid",
      "purpose": "DRINK",
      "mood": "TIPSY"
    },
    "meetingEffects": [
      {
        "meetingId": "meeting-uuid",
        "action": "RECOMMENDATION_REMOVED",
        "candidateRemoved": false
      }
    ]
  }
}
```

### 6.6 내 장소 등록 해제

```http
POST /api/v1/me/places/{userPlaceId}/unregister
```

```json
{
  "removeFromMeetingIds": [
    "meeting-uuid"
  ]
}
```

- 빈 배열이면 `내 장소`에서만 등록 해제한다.
- 지정된 모집 중 모임에서는 사용자의 후보 추천도 함께 취소한다.
- 다른 추천자가 남아 있으면 통합 후보는 유지한다.
- 다른 추천자가 없으면 통합 후보도 제거한다.
- 투표 생성 후 고정된 후보는 변경하지 않는다.

응답:

```json
{
  "data": {
    "unregistered": true,
    "meetingEffects": [
      {
        "meetingId": "meeting-uuid",
        "action": "RECOMMENDATION_REMOVED",
        "candidateRemoved": true
      }
    ]
  }
}
```

## 7. 모임 API

### 7.1 모임 생성

```http
POST /api/v1/meetings
```

```json
{
  "name": "7/29 파티룸",
  "capacity": 6,
  "startsAt": "2026-07-29T19:30:00+09:00",
  "purpose": "DRINK",
  "mood": "FUN"
}
```

검증:

- 모임 이름은 1~20글자다.
- 정원은 최소 2명이며 제품 정책상 최대 제한은 없다.
- 분은 `00` 또는 `30`이어야 한다.
- 목적과 성격은 허용된 값 중 하나여야 한다.

응답 `201 Created`:

```json
{
  "data": {
    "id": "meeting-uuid",
    "name": "7/29 파티룸",
    "capacity": 6,
    "currentMemberCount": 1,
    "startsAt": "2026-07-29T19:30:00+09:00",
    "purpose": "DRINK",
    "mood": "FUN",
    "joinCode": "2741",
    "shareUrl": "https://damo.com/meetings/meeting-uuid",
    "status": "RECRUITING",
    "myRole": "HOST"
  }
}
```

- 진행 중인 모임과 겹치지 않는 가입 코드를 서버가 발급한다.
- 모임 생성자도 `HOST` 역할의 참여자로 등록한다.

### 7.2 코드로 모임 확인

```http
POST /api/v1/meetings/lookup
```

```json
{
  "joinCode": "2741"
}
```

응답:

```json
{
  "data": {
    "meetingId": "meeting-uuid",
    "name": "7/29 파티룸",
    "startsAt": "2026-07-29T19:30:00+09:00",
    "purpose": "DRINK",
    "mood": "FUN",
    "currentMemberCount": 4,
    "capacity": 6,
    "canJoin": true,
    "defaultNickname": "다모"
  }
}
```

오류:

| 코드 | 상황 |
| --- | --- |
| `INVALID_JOIN_CODE` | 코드 형식 오류 또는 존재하지 않음 |
| `MEETING_NOT_RECRUITING` | 투표 시작·완료 상태 |
| `MEETING_FULL` | 정원 초과 |
| `MEETING_DELETED` | 삭제된 모임 |

### 7.3 모임 가입 또는 재가입

```http
POST /api/v1/meetings/{meetingId}/join
```

```json
{
  "joinCode": "2741",
  "nickname": "다모"
}
```

처리:

1. 모임 상태와 가입 코드를 확인한다.
2. 정원을 트랜잭션 안에서 다시 확인한다.
3. 처음 가입하면 새 참여자를 생성한다.
4. 기존 상태가 `LEFT` 또는 `KICKED`이면 `ACTIVE`로 복구한다.
5. 재가입 시 이전 후보 추천은 복구하지 않는다.

응답:

```json
{
  "data": {
    "memberId": "member-uuid",
    "meetingId": "meeting-uuid",
    "nickname": "다모",
    "role": "MEMBER",
    "rejoined": true,
    "nextPath": "/meetings/meeting-uuid/candidates"
  }
}
```

### 7.4 모임 상세

```http
GET /api/v1/meetings/{meetingId}
```

응답에는 다음 내용을 포함한다.

- 모임 이름, 날짜·시각, 목적, 성격
- 현재 인원과 정원
- 내 역할과 모임 닉네임
- 참여자 목록
- 가입 코드와 공유 링크: 모임장에게만 제공
- 후보 목록과 추천 인원 수
- 투표 상태와 내 투표 진행 상태
- 현재 가능한 행동

```json
{
  "data": {
    "id": "meeting-uuid",
    "name": "7/29 파티룸",
    "status": "RECRUITING",
    "myRole": "HOST",
    "permissions": {
      "canLeave": false,
      "canKick": true,
      "canStartVote": true,
      "canCloseVote": false,
      "canDeleteMeeting": true
    }
  }
}
```

### 7.5 모임 탈퇴

```http
POST /api/v1/meetings/{meetingId}/leave
```

- `MEMBER`만 요청할 수 있다.
- `RECRUITING` 상태에서만 가능하다.
- 사용자의 추천을 제거하고 추천자가 없는 후보도 제거한다.
- 모임장은 `403 HOST_CANNOT_LEAVE`를 반환한다.

응답 `204 No Content`.

### 7.6 모임원 내보내기

```http
POST /api/v1/meetings/{meetingId}/members/{memberId}/kick
```

- 모임장만 요청할 수 있다.
- 투표 생성 전까지만 가능하다.
- 대상의 후보 추천도 제거한다.
- 대상 사용자는 투표 생성 전이고 정원에 여유가 있으면 다시 가입할 수 있다.

응답:

```json
{
  "data": {
    "memberId": "member-uuid",
    "status": "KICKED",
    "removedRecommendationCount": 2,
    "removedCandidateCount": 1
  }
}
```

### 7.7 모임 삭제

```http
DELETE /api/v1/meetings/{meetingId}
```

- 모임장만 요청할 수 있다.
- 모든 모임 상태에서 가능하다.
- 프론트엔드는 삭제 요청 전에 경고창을 표시한다.
- 삭제된 모임은 홈과 조회 결과에서 숨긴다.
- 공유 링크와 가입 코드를 사용할 수 없게 한다.

응답 `204 No Content`.

## 8. 후보 API

### 8.1 선택 가능한 내 장소

```http
GET /api/v1/meetings/{meetingId}/eligible-places
```

모임 목적 또는 성격 중 하나 이상이 일치하는 내 장소를 반환한다.

```json
{
  "data": {
    "items": [
      {
        "userPlaceId": "user-place-uuid",
        "placeName": "을지로 보석",
        "purpose": "MEAL",
        "mood": "FUN",
        "matchReasons": [
          "MOOD"
        ],
        "selected": true,
        "currentRecommenderCount": 3
      }
    ],
    "selectedCount": 1,
    "maxSelectableCount": 2,
    "candidatesFrozen": false
  }
}
```

### 8.2 통합 후보 목록

```http
GET /api/v1/meetings/{meetingId}/candidates
```

```json
{
  "data": {
    "items": [
      {
        "candidateId": "candidate-uuid",
        "place": {
          "name": "을지로 보석",
          "category": "한식",
          "roadAddress": "서울 중구 수표로 48"
        },
        "recommenderCount": 3,
        "recommendedByMe": true,
        "frozen": false
      }
    ]
  }
}
```

### 8.3 내 후보 교체

```http
PUT /api/v1/meetings/{meetingId}/candidates/me
```

요청한 배열로 내 후보 전체를 교체한다.

```json
{
  "userPlaceIds": [
    "user-place-uuid-1",
    "user-place-uuid-2"
  ]
}
```

- 빈 배열이면 모든 후보 선택을 취소한다.
- 최대 2개까지만 허용한다.
- 현재 사용자의 활성 `내 장소`만 선택할 수 있다.
- 모임 목적 또는 성격 중 하나 이상이 일치해야 한다.
- 투표 생성 후에는 변경할 수 없다.

오류:

| 코드 | 상황 |
| --- | --- |
| `TOO_MANY_CANDIDATES` | 3개 이상 선택 |
| `USER_PLACE_NOT_ELIGIBLE` | 목적과 성격이 모두 불일치 |
| `USER_PLACE_NOT_FOUND` | 내 장소가 아니거나 등록 해제됨 |
| `CANDIDATES_ALREADY_FROZEN` | 투표 생성 후 변경 |

## 9. 투표 API

### 9.1 투표 생성

```http
POST /api/v1/meetings/{meetingId}/vote
```

- 모임장만 요청할 수 있다.
- 중복 제거 후보가 2개 이상이어야 한다.
- 후보와 추천 정보를 고정한다.
- 활성 참여자별 개인 투표 세션을 생성한다.
- 후보가 `N`개면 개인별 `N-1`라운드를 진행한다.

응답 `201 Created`:

```json
{
  "data": {
    "voteId": "vote-uuid",
    "status": "OPEN",
    "candidateCount": 5,
    "roundsPerMember": 4,
    "participantCount": 4,
    "startedAt": "2026-07-25T20:00:00+09:00"
  }
}
```

### 9.2 내 현재 라운드

```http
GET /api/v1/meetings/{meetingId}/vote/session
```

응답:

```json
{
  "data": {
    "status": "IN_PROGRESS",
    "roundNumber": 2,
    "totalRounds": 4,
    "completedRounds": 1,
    "candidateA": {
      "candidateId": "candidate-a-uuid",
      "name": "을지로 보석",
      "category": "한식",
      "recommenderCount": 3
    },
    "candidateB": {
      "candidateId": "candidate-b-uuid",
      "name": "문래 와인바",
      "category": "와인바",
      "recommenderCount": 2
    }
  }
}
```

- 재접속하면 완료하지 않은 다음 라운드를 반환한다.
- 투표를 완료했다면 `status = COMPLETED`와 결과 화면 경로를 반환한다.
- 투표가 종료됐다면 확정된 결과를 안내한다.

### 9.3 A/B 선택 저장

```http
POST /api/v1/meetings/{meetingId}/vote/choices
```

```json
{
  "roundNumber": 2,
  "candidateAId": "candidate-a-uuid",
  "candidateBId": "candidate-b-uuid",
  "selectedCandidateId": "candidate-a-uuid",
  "requestId": "choice-request-uuid"
}
```

검증:

- 요청 라운드가 서버의 현재 라운드와 일치해야 한다.
- 선택 후보는 A 또는 B 중 하나여야 한다.
- 같은 세션과 라운드의 선택은 한 번만 반영한다.
- 네트워크 재시도로 같은 `requestId`가 들어오면 기존 응답을 반환한다.

응답:

```json
{
  "data": {
    "savedRoundNumber": 2,
    "sessionStatus": "IN_PROGRESS",
    "completedRounds": 2,
    "totalRounds": 4,
    "nextRound": {
      "roundNumber": 3,
      "candidateAId": "candidate-a-uuid",
      "candidateBId": "candidate-c-uuid"
    }
  }
}
```

마지막 라운드라면:

```json
{
  "data": {
    "savedRoundNumber": 4,
    "sessionStatus": "COMPLETED",
    "completedRounds": 4,
    "totalRounds": 4,
    "nextPath": "/meetings/meeting-uuid/results"
  }
}
```

### 9.4 실시간 결과

```http
GET /api/v1/meetings/{meetingId}/vote/results
```

```json
{
  "data": {
    "voteStatus": "OPEN",
    "meetingStatus": "VOTING",
    "participantCount": 4,
    "completedParticipantCount": 2,
    "incompleteParticipantCount": 2,
    "rankings": [
      {
        "rank": 1,
        "candidateId": "candidate-uuid",
        "name": "을지로 보석",
        "voteCount": 9,
        "recommenderCount": 3,
        "jointRank": false
      }
    ],
    "finalCandidate": null,
    "updatedAt": "2026-07-25T20:35:00+09:00",
    "pollAfterMs": 5000
  }
}
```

- 투표를 완료한 모임원과 모임장이 조회할 수 있다.
- 모임장은 투표 중에도 관리 화면에서 진행 현황을 조회할 수 있다.
- 프론트엔드는 결과 화면이 보이는 동안 5초마다 조회한다.
- 단순 득표수는 저장된 모든 A/B 선택을 합산한다.

### 9.5 모임장 수동 종료

1차 요청:

```http
POST /api/v1/meetings/{meetingId}/vote/close
```

```json
{
  "force": false
}
```

미완료 인원이 있다면 `409`:

```json
{
  "error": {
    "code": "INCOMPLETE_VOTERS_EXIST",
    "message": "아직 투표를 완료하지 않은 인원이 있습니다.",
    "details": {
      "incompleteParticipantCount": 2,
      "confirmationOptions": [
        "WAIT",
        "FORCE_CLOSE"
      ]
    },
    "requestId": "req_01J..."
  }
}
```

사용자가 `그래도 종료`를 선택한 경우:

```http
POST /api/v1/meetings/{meetingId}/vote/close
```

```json
{
  "force": true
}
```

처리:

- 추가 선택 요청을 막는다.
- 미완료 세션에서 이미 저장된 선택도 각각 1표로 집계한다.
- 단독 1위이면 자동 확정한다.
- 공동 1위이면 `FINAL_SELECTION` 상태로 변경한다.

단독 1위 응답:

```json
{
  "data": {
    "meetingStatus": "COMPLETED",
    "resultType": "SINGLE_WINNER",
    "finalCandidate": {
      "candidateId": "candidate-uuid",
      "name": "을지로 보석"
    }
  }
}
```

공동 1위 응답:

```json
{
  "data": {
    "meetingStatus": "FINAL_SELECTION",
    "resultType": "JOINT_FIRST",
    "jointFirstCandidates": [
      {
        "candidateId": "candidate-a-uuid",
        "name": "을지로 보석",
        "voteCount": 9,
        "recommenderCount": 3
      },
      {
        "candidateId": "candidate-b-uuid",
        "name": "문래 와인바",
        "voteCount": 9,
        "recommenderCount": 3
      }
    ]
  }
}
```

### 9.6 공동 1위 최종 선택

```http
POST /api/v1/meetings/{meetingId}/vote/final-selection
```

```json
{
  "candidateId": "candidate-a-uuid"
}
```

- 모임장만 요청할 수 있다.
- 모임 상태가 `FINAL_SELECTION`이어야 한다.
- 공동 1위 후보 중 하나만 선택할 수 있다.

응답:

```json
{
  "data": {
    "meetingStatus": "COMPLETED",
    "finalCandidate": {
      "candidateId": "candidate-a-uuid",
      "name": "을지로 보석"
    },
    "completedAt": "2026-07-25T21:00:00+09:00"
  }
}
```

## 10. 권한과 상태 검사

| API | 필요한 권한 | 허용 상태 |
| --- | --- | --- |
| 모임 가입 | 로그인 사용자 | `RECRUITING` |
| 후보 변경 | 활성 참여자 | `RECRUITING` |
| 모임 탈퇴 | `MEMBER` | `RECRUITING` |
| 모임원 내보내기 | `HOST` | `RECRUITING` |
| 투표 생성 | `HOST` | `RECRUITING` |
| A/B 선택 | 활성 참여자 | `VOTING` |
| 투표 종료 | `HOST` | `VOTING` |
| 최종 선택 | `HOST` | `FINAL_SELECTION` |
| 모임 삭제 | `HOST` | 삭제 전 모든 상태 |

프론트엔드에 버튼이 보이지 않더라도 서버가 요청마다 다시 검사한다.

## 11. 주요 오류 코드

### 11.1 인증

| 코드 | 설명 |
| --- | --- |
| `AUTH_REQUIRED` | 로그인이 필요함 |
| `SESSION_EXPIRED` | 로그인 세션 만료 |
| `INVALID_CREDENTIALS` | 아이디 또는 비밀번호 오류 |
| `OAUTH_FAILED` | OAuth 인증 실패 |
| `TEST_AUTH_DISABLED` | 테스트 로그인이 비활성화됨 |

### 11.2 모임

| 코드 | 설명 |
| --- | --- |
| `MEETING_NOT_FOUND` | 모임이 없거나 조회할 수 없음 |
| `MEETING_DELETED` | 삭제된 모임 |
| `MEETING_FULL` | 정원 초과 |
| `MEETING_NOT_RECRUITING` | 가입·후보 변경이 불가능한 상태 |
| `INVALID_JOIN_CODE` | 가입 코드 오류 |
| `HOST_CANNOT_LEAVE` | 모임장 탈퇴 시도 |
| `MEMBER_ALREADY_ACTIVE` | 이미 참여 중인 사용자 |
| `NOT_MEETING_HOST` | 모임장 권한 필요 |
| `INVALID_CAPACITY` | 정원이 2명 미만 |
| `INVALID_MEETING_TIME` | 분이 00/30이 아니거나 날짜 형식 오류 |

### 11.3 장소와 후보

| 코드 | 설명 |
| --- | --- |
| `USER_PLACE_NOT_FOUND` | 내 장소가 아니거나 등록 해제됨 |
| `USER_PLACE_ALREADY_SAVED` | 이미 저장된 장소 |
| `TOO_MANY_CANDIDATES` | 후보 2개 초과 |
| `USER_PLACE_NOT_ELIGIBLE` | 모임 목적·성격과 모두 불일치 |
| `CANDIDATES_ALREADY_FROZEN` | 투표 생성 후 후보 변경 시도 |
| `NOT_ENOUGH_CANDIDATES` | 후보 2개 미만 |

### 11.4 투표

| 코드 | 설명 |
| --- | --- |
| `VOTE_NOT_FOUND` | 생성된 투표 없음 |
| `VOTE_ALREADY_CREATED` | 중복 투표 생성 |
| `VOTE_ALREADY_CLOSED` | 종료 후 선택 또는 종료 요청 |
| `INVALID_VOTE_ROUND` | 현재 라운드와 요청이 다름 |
| `INVALID_SELECTED_CANDIDATE` | A/B 외의 후보 선택 |
| `INCOMPLETE_VOTERS_EXIST` | 미완료 인원이 있어 종료 확인 필요 |
| `FINAL_SELECTION_NOT_REQUIRED` | 공동 1위 상태가 아님 |
| `CANDIDATE_NOT_JOINT_FIRST` | 공동 1위가 아닌 후보 선택 |

## 12. 5초 폴링 규칙

### 12.1 홈

대상:

```http
GET /api/v1/me/home
```

- 홈 화면이 보이는 동안 5초마다 호출한다.
- `document.visibilityState !== "visible"`이면 중단한다.
- 다시 화면이 보이면 즉시 한 번 호출하고 5초 주기를 재개한다.
- 로그아웃 또는 `401` 발생 시 중단한다.

### 12.2 투표 결과

대상:

```http
GET /api/v1/meetings/{meetingId}/vote/results
```

- 결과 화면이 보이는 동안 5초마다 호출한다.
- `voteStatus`가 `CLOSED`이면 반복 호출을 중단한다.
- 요청이 겹치지 않도록 이전 요청이 끝난 뒤 다음 타이머를 시작한다.

### 12.3 WebSocket 전환

사용량이 늘면 다음 이벤트를 WebSocket으로 전달한다.

```text
meeting.updated
meeting.member.updated
meeting.candidate.updated
vote.started
vote.result.updated
vote.closed
meeting.completed
```

REST 응답 구조는 그대로 유지하고, WebSocket 이벤트에는 변경된 데이터의 ID와 최신 `updatedAt`을 포함한다.

## 13. 중복 요청과 트랜잭션

다음 작업은 반드시 하나의 데이터베이스 트랜잭션으로 처리한다.

- 모임 생성과 중복되지 않는 가입 코드 발급
- 모임 가입·재가입과 정원 확인
- 탈퇴·내보내기와 추천 후보 제거
- 내 장소 변경·등록 해제와 선택된 모임 후보 반영
- 투표 생성과 후보 고정·개인 세션 생성
- A/B 선택과 개인 진행 상태 갱신
- 투표 종료와 순위·최종 장소 확정

다음 요청은 중복 실행돼도 결과가 한 번만 반영되어야 한다.

- 모임 생성
- 모임 가입
- 후보 전체 교체
- 투표 생성
- A/B 선택
- 투표 종료
- 공동 1위 최종 선택

프론트엔드는 중요한 생성·선택 요청에 `Idempotency-Key` 헤더 또는 요청 본문의 `requestId`를 사용한다.

## 14. 프론트엔드 개발 순서

백엔드가 완성되기 전에는 이 명세의 JSON을 이용해 Mock Service Worker 등의 목 서버를 만들 수 있다.

권장 구현 순서:

1. 공통 API 클라이언트와 오류 처리
2. 테스트 로그인과 OAuth 이동
3. 홈 목록
4. 지도와 내 장소
5. 모임 생성·가입
6. 후보 선택
7. A/B 투표와 재접속
8. 5초 결과 갱신
9. 투표 종료와 공동 1위 선택
10. 삭제·탈퇴·내보내기 예외 처리

## 15. 다음 단계

이 문서를 기준으로 `openapi.yaml` 작성을 완료했다. 다음 작업을 진행한다.

1. `openapi.yaml` 검토 및 확정
2. 프론트엔드용 API 타입 생성
3. 목 서버 구성
4. 백엔드 데이터베이스 마이그레이션 작성
5. 인증 및 핵심 API 구현
