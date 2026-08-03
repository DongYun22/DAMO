# PostgresStore 쓰기 경로 경량화 설계

- 작성일: 2026-07-29
- 배경: Render 배포 사이트(`https://damo-preview.onrender.com`)에서 `POST /api/v1/meetings/lookup`을 3회 반복 측정한 결과 매번 1.1~1.24초가 걸림을 확인. 원인은 `postgres-store.ts`의 `write()`/`read()` 헬퍼가 요청마다 `users`/`places`/`meetings`/`meeting_members`/`meeting_candidates`/`candidate_recommendations`/`votes`/`vote_sessions`/`vote_choices`/`auth_sessions` 전체를 메모리로 로드했다가 다시 저장하는 구조이기 때문. 이후 `POST /api/v1/meetings`(모임 생성)와 `DELETE /api/v1/meetings/:id`(모임 삭제)를 같은 방식으로 측정한 결과 **각각 약 30초**가 걸림을 추가로 확인 — `write()`는 `read()`와 달리 전체 스냅샷을 다시 저장까지 하므로, 지금 프로덕션에 쌓인 데이터량 기준으로 비용이 훨씬 크다.

## 목표와 범위

이번 스펙은 **"서비스 가능한 DAMO"라는 큰 목표 중 DB 쓰기 성능 경량화 한 조각만** 다룬다. OAuth 실연동, 인증 토큰 보안, 5초 폴링 → WebSocket/SSE 전환, API 요청 제한은 별도 스펙으로 다음 사이클에 진행한다.

전체 스냅샷 방식(`write()`/`read()`)에 남아있는 12개 메서드 중 **사용 빈도가 높은 6개 + `deleteMeeting`을 이번에 전환**한다.

- 전환 대상: `lookupMeeting`, `joinMeeting`, `createMeeting`, `deleteMeeting`, `createVote`, `closeVote`, `finalSelection`
- 다음 사이클로 보류: `leaveMeeting`, `kickMember`, `updateUserPlace`, `unregisterUserPlace`, `reset` (사용 빈도가 낮아 우선순위를 낮춤)

> **범위 추가 (실측 후 결정)**: `deleteMeeting`은 원래 "다음 사이클"로 미뤄뒀으나, `createMeeting`과 함께 실측한 ~30초가 그대로 재현되어 이번 배치에 포함시켰다. 로직 자체가 호스트 검증 + `status='DELETED'` 단일 UPDATE라 다른 5개보다 훨씬 단순해서 리스크 대비 효과가 크다.

> **정정 (구현 계획 작성 중 발견)**: `voteResults()`도 실제로는 아직 `read()`(전체 스냅샷 로드) 방식이었다 — 아래 "voteResults 재사용" 서술은 잘못된 전제였다. `closeVote`/`finalSelection`이 동점 판정을 위해 `voteResults`를 그대로 호출하므로, `voteResults`도 이번 범위에 포함해 SQL로 전환한다. 별도 작업이 추가되는 게 아니라 `closeVote`/`finalSelection`을 SQL로 만들기 위한 필수 선행 작업이다.

## 락 전략

지금은 모든 쓰기가 전역 advisory lock(`hashtext('damo-store-write')`) 하나를 공유해서, 서로 무관한 모임의 요청도 직렬로 대기한다.

이번 전환부터는 모임별 스코프 락으로 통일한다.

```ts
private async withMeetingLock<T>(
  meetingId: string,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await this.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext($1))",
      [`meeting:${meetingId}`]
    );
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
```

- 이미 SQL로 전환된 `replaceMyCandidates`(`candidate:${meetingId}` 락)와 `saveChoice`(전역 락)도 이 헬퍼로 통일해서, 락 스코프를 `meeting:{id}` 하나로 일관되게 정리한다.
- `createMeeting`은 아직 `meetingId`가 없는 신규 행이라 락이 필요 없다 — 가입 코드 유니크 제약은 DB 유니크 인덱스가 보장한다.
- 이번에 전환하지 않는 나머지 5개 메서드는 계속 전역 락(`write()`)을 사용한다.

## 메서드별 전환 계획

| 메서드 | 락 | 반드시 보존할 규칙 (`store.ts` 기준) |
|---|---|---|
| `lookupMeeting` | 없음 (읽기 전용) | `status NOT IN ('COMPLETED','DELETED')`인 모임만 대상, 활성 인원수 `< capacity`면 `canJoin: true` (`store.ts:860`) |
| `joinMeeting` | `meeting:{id}` | 가입 코드 일치, `status='RECRUITING'`, 정원 초과 검사(재가입 멤버는 예외), 기존 탈퇴 멤버는 UPDATE로 재활성화·신규는 INSERT (`store.ts:882`) |
| `createMeeting` | 없음 (신규 행) | 호스트 멤버 행도 같은 트랜잭션에서 함께 생성, 가입 코드 충돌 시 재생성 (`store.ts:762`) |
| `deleteMeeting` | `meeting:{id}` | 호스트 검증, `status='DELETED'` + `deleted_at` 설정 (`store.ts:943`) |
| `createVote` | `meeting:{id}` | 호스트 검증, `status='RECRUITING'`, 추천받은 후보 ≥2, 후보 `is_frozen=true` 고정, 참여자별 회전된 후보 순서로 `vote_sessions` 생성, 모임 상태 `VOTING` 전환 (`store.ts:1037`) |
| `closeVote` | `meeting:{id}` | 호스트 검증, `status='VOTING'`, 미완료 인원 있으면 `force` 없이는 거부, 단독 1위면 `CLOSED`+`COMPLETED`+최종 후보 확정, 공동 1위면 `FINAL_SELECTION` (`store.ts:1188`) |
| `finalSelection` | `meeting:{id}` | 호스트 검증, `status='FINAL_SELECTION'`, 선택 후보가 공동 1위 목록에 있어야 함, `COMPLETED` 전환 (`store.ts:1215`) |

**공유 하위 로직 — 정기 모임 다음 회차 생성**: `closeVote`와 `finalSelection`은 모임에 `recurrenceType`이 있으면 마지막에 다음 회차를 자동 생성한다(`store.ts:1271` `createNextRecurringOccurrence` — 새 모임 행 + 활성 멤버 복사 INSERT). 두 메서드에서 중복 구현하지 않도록 `private createNextRecurringOccurrence(client, meetingId)` SQL 헬퍼를 하나만 만들어 공유한다.

`voteResults`는 이번 배치에서 `computeVoteResults` SQL 헬퍼로 새로 전환하고(위 "정정" 참고), `closeVote`/`finalSelection`은 동점 판정 로직을 새로 짜지 않고 이 헬퍼를 그대로 호출해 재사용한다.

## 에러 처리

새 SQL 코드는 `store.ts`와 동일한 `StoreError` 코드·메시지를 그대로 사용한다(예: `MEETING_CAPACITY_EXCEEDED`, `NOT_ENOUGH_CANDIDATES`, `VOTE_HAS_INCOMPLETE_MEMBERS`). 프론트엔드는 에러 코드로 분기하므로([apps/web/src/pages.tsx](../../../apps/web/src/pages.tsx)) 코드 값만 동일하면 프론트 변경이 필요 없다. 이미 전환된 `replaceMyCandidates`/`saveChoice`가 쓰는 방식과 동일하다.

## 테스트 계획

`postgres-store.ts`는 현재 자동 테스트가 전혀 없다(`pnpm test:api`는 메모리 스토어만 검증). 이번 전환부터 실제 Postgres 대상 통합 테스트를 추가한다.

- `apps/mock-api/src/postgres-store.test.ts`(신규)를 추가하고, 기존 [server.test.ts](../../../apps/mock-api/src/server.test.ts)의 테스트 케이스(모임 생성, 코드 조회·가입, 투표 흐름 등)를 재사용해 PostgresStore에 대해 동일하게 검증한다.
- `TEST_DATABASE_URL` 환경변수가 없으면 이 스위트 전체를 skip한다 — 로컬에 별도 Supabase를 안 붙인 사람의 `pnpm test:api`는 지금처럼 메모리 스토어만 계속 검증된다.
- **격리 원칙**: `TEST_DATABASE_URL`은 Render/프로덕션이 쓰는 `DATABASE_URL`과 절대 다른 값이어야 한다. 사용자가 별도 Supabase 프로젝트를 새로 만들어 이 값을 발급한다(제가 Supabase 프로젝트를 직접 만들 수는 없으므로, 실행 계획에는 "Supabase 새 프로젝트 생성 → 마이그레이션 적용(`pnpm db:migrate`) → 연결 문자열을 `apps/mock-api/.env.local`의 `TEST_DATABASE_URL`에 등록"을 사람이 할 일로 명시한다).
- 매 테스트 전에는 `/api/v1/__mock/reset` 대신 테스트 코드 안에서 직접 `store.reset()`을 호출해 데이터를 비운다.
- 검증 범위: 가입 코드 조회·가입, 모임 생성 시 호스트 멤버 동시 생성, 모임 삭제와 호스트 검증, 투표 생성 시 후보 고정과 세션 회전, 종료 시 단독/공동 1위 분기, 최종 선택, 정기 모임 다음 회차 자동 생성.

## 문서화

- README "현재 MVP에서 남은 작업" 목록의 "PostgreSQL 저장소의 나머지 변경 작업을 개별 SQL로 전환" 항목을 갱신 — 이번에 전환된 7개는 제외하고, 남은 5개(`leaveMeeting`, `kickMember`, `updateUserPlace`, `unregisterUserPlace`, `reset`)를 구체적으로 명시.
- `docs/database.md`에 락 전략 변경(전역 락 → `meeting:{id}` 스코프 락) 한 줄 추가.
- `docs/local-development.md`에 테스트용 Supabase 프로젝트 설정 방법(`TEST_DATABASE_URL`) 안내 추가.

> **범위 재확장 (구현 중 결정, 2026-07-29)**: Task 3(`withMeetingLock` 통일) 코드 리뷰에서 Critical 등급 문제가 발견됐다 — 일부 메서드만 모임별 락으로 옮기고 나머지가 전역 락(`write()`)에 남아있으면, 서로 다른 락 네임스페이스라 서로를 막지 못한다. `write()`의 `saveSnapshot()`은 `vote_choices`/`candidate_recommendations`를 통째로 지웠다가 자기 스냅샷 기준으로 재삽입하므로, 무관한 모임의 `write()` 트랜잭션이 모임별 락 트랜잭션이 방금 커밋한 데이터를 조용히 지울 수 있다. 임시방편(이중 락)보다 근본 해결이 낫다고 판단해 `leaveMeeting`, `kickMember`, `updateUserPlace`, `unregisterUserPlace`도 이번 배치에 포함시켰다 — 자세한 내용은 구현 계획 문서 상단의 "범위 확장" 노트 참고.

## 이번에 다루지 않는 것

- `reset`의 SQL 전환 — DB 전체 초기화가 목적이라 대상에서 제외 (실사용자 동시 트래픽과 무관하고, 프로덕션에서는 `DAMO_ENABLE_DB_RESET`으로 차단됨)
- 실제 OAuth 연동, 인증 토큰 서명·만료 정책
- 5초 폴링 → WebSocket/SSE 전환
- API 요청 제한·보안 로그
