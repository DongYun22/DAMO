# DAMO

> 각자가 저장한 장소를 모아, 가벼운 A/B 선택으로 다음 모임 장소를 정하는 모바일 웹 서비스

DAMO는 카카오톡 등으로 모임 코드를 공유하고, 참여자들이 각자의 `내 장소`에서 후보를 추천한 뒤 투표로 최종 장소를 정하도록 돕는 프로젝트입니다.

현재 단계는 실제 모바일 브라우저에서 전체 흐름을 검증할 수 있는 MVP 프로토타입입니다. 테스트 로그인, 모임 생성과 가입, 네이버 장소 검색, 후보 추천, A/B 투표, 결과 집계, Supabase 영구 저장과 Render 통합 배포까지 구현되어 있습니다.

## 먼저 알아둘 내용

- 별도의 Windows 앱이나 모바일 앱 설치가 필요하지 않습니다. 모든 사용자는 하나의 웹 링크로 접속합니다.
- 로그인 후 홈, 지도, 내 장소 화면을 이용할 수 있습니다.
- 테스트 단계에서는 아이디와 비밀번호 로그인을 사용합니다.
- 카카오·네이버·구글 OAuth 버튼은 현재 프로토타입 흐름이며 실제 제공자 인증은 아직 연결하지 않았습니다.
- 네이버 지도 인증 정보가 없어도 샘플 장소와 목 지도로 핵심 기능을 확인할 수 있습니다.
- `DATABASE_URL`이 없으면 메모리에 저장하므로 API 서버를 재시작할 때 데이터가 초기화됩니다.
- `DATABASE_URL`을 설정하면 Supabase PostgreSQL에 영구 저장합니다.

## 서비스 흐름

1. 사용자가 로그인합니다.
2. 누구나 모임을 만들 수 있으며, 만든 사람이 모임장이 됩니다.
3. 모임장은 모임명, 정원, 날짜와 시각, 목적, 성격을 설정합니다.
4. 다른 사용자는 공유받은 4자리 코드로 모임에 가입합니다.
5. 각 참여자는 `내 장소`에서 최대 2곳을 후보로 추천합니다.
6. 같은 네이버 장소를 여러 사람이 추천하면 하나의 후보로 합치고 추천 인원 수를 표시합니다.
7. 후보가 2개 이상이면 모임장이 투표를 시작할 수 있습니다.
8. 후보가 `N`개라면 각 참여자는 `N-1`회의 A/B 선택을 진행합니다.
9. 모든 A/B 선택은 선택된 장소에 1표로 집계됩니다.
10. 단독 1위는 자동 확정하고, 공동 1위는 모임장이 최종 장소를 선택합니다.

후보 선택 화면에는 저장된 모든 장소를 보여줍니다. 모임 목적과 성격이 모두 맞는 장소, 하나만 맞는 장소, 모두 맞지 않는 장소 순으로 정렬하며 같은 조건에서는 장소명을 가나다순으로 표시합니다. 조건이 맞지 않는 장소도 선택할 수 있지만 흐리게 표시하고 `조건 불일치` 상태를 보여줍니다.

## 주요 기능

### 계정

- 테스트 계정 즉시 가입과 로그인
- 모임별 닉네임 변경
- 카카오·네이버·구글 OAuth 목 흐름
- Access Token 기반 보호 API

### 모임

- 모임 생성과 무작위 4자리 가입 코드 발급
- 모임 가입, 탈퇴, 재가입
- 모임장 전용 모임원 내보내기와 모임 삭제
- 진행 중인 모임과 완료된 모임 분리
- 5초 간격 상태 갱신과 투표 알림

### 지도와 내 장소

- 네이버 Dynamic Map 연동
- 네이버 지역 검색 API 기반 장소 검색
- 검색어 미리보기와 지도 하단 결과 카드
- 장소 상세 확인
- 목적과 성격을 지정해 `내 장소`에 저장
- 저장된 장소의 분류 변경과 등록 해제
- 후보 화면에서 지도로 이동한 경우 현재 모임 후보로 바로 추가

### 후보와 투표

- 사용자당 후보 최대 2개
- 같은 장소의 중복 후보 통합
- 추천 인원 수 표시
- 후보 수 기준 `N-1`회 A/B 투표
- 투표 완료 후 실시간 득표수 확인
- 미완료 참여자가 있을 때 종료 재확인
- 득표수 → 추천 인원 수 순서의 동점 처리
- 단독 1위 자동 확정과 공동 1위 모임장 선택

## 기술 구성

| 영역 | 사용 기술 |
| --- | --- |
| 모바일 웹 | React 19, TypeScript, Vite |
| API 서버 | Node.js, Express 5, Zod |
| 데이터베이스 | Supabase PostgreSQL, `pg` |
| 지도 | 네이버 클라우드 Dynamic Map |
| 장소 검색 | 네이버 Developers 지역 검색 API |
| 인증 | 테스트 로그인, bcrypt 비밀번호 해시, OAuth 목 흐름 |
| 공용 계약 | pnpm workspace의 `@damo/contracts` |
| 배포 | Render Web Service |
| API 문서 | Markdown, OpenAPI 3.1 |

```text
모바일 브라우저
    │
    ▼
React + Vite
    │  /api/v1
    ▼
Express API
    ├─ 네이버 지역 검색 API
    └─ Supabase PostgreSQL
```

프론트엔드는 Supabase에 직접 연결하지 않습니다. 데이터베이스 비밀번호와 네이버 검색 Client Secret은 Express API 서버만 사용합니다.

## 저장소 구조

```text
DAMO/
├─ apps/
│  ├─ web/                    # React 모바일 웹
│  │  ├─ src/App.tsx          # 화면 라우팅
│  │  ├─ src/pages.tsx        # 화면별 주요 로직
│  │  ├─ src/components.tsx   # 공용 UI와 네이버 지도
│  │  └─ src/styles.css       # Glassmorphism 기반 스타일
│  └─ mock-api/               # Express API 서버
│     ├─ src/server.ts        # API 라우트
│     ├─ src/store.ts         # 메모리 저장소와 도메인 규칙
│     ├─ src/postgres-store.ts # PostgreSQL 저장소
│     └─ migrations/          # 데이터베이스 마이그레이션
├─ packages/
│  └─ contracts/              # 프론트엔드와 API가 공유하는 TypeScript 타입
├─ docs/                      # 기획·흐름·데이터·API·개발 문서
├─ render.yaml                # Render Blueprint
├─ pnpm-workspace.yaml        # 모노레포 구성
└─ package.json               # 루트 실행 명령
```

## 가장 빠르게 로컬에서 실행하기

외부 API나 Supabase 없이 샘플 데이터로 실행하는 방법입니다.

### 1. 준비

- Node.js `20.12 이상, 25 미만`
- Corepack
- Git

Windows PowerShell에서 다음 명령을 실행합니다.

```powershell
git clone https://github.com/Riverwon2/DAMO.git
Set-Location DAMO
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

기본 주소:

- 웹: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4010`
- API 상태 확인: `http://127.0.0.1:4010/health`

5173 포트가 사용 중이면 Vite가 5174처럼 다음 포트를 선택합니다. 브라우저 주소는 터미널에 표시된 `Local` 값을 사용하면 됩니다.

### 2. 테스트 로그인

| 아이디 | 비밀번호 | 닉네임 |
| --- | --- | --- |
| `damo` | `1234` | 가은 |
| `minsu` | `1234` | 민수 |
| `jiyun` | `1234` | 지윤 |

샘플 모임 가입 코드는 `4821`입니다.

### 3. 기본 검사

```powershell
pnpm typecheck
pnpm test:api
pnpm build:render
```

세 명령이 모두 성공하면 공용 타입, API 규칙, 배포용 웹 빌드가 정상입니다.

## Supabase 영구 데이터베이스 연결

메모리 저장소 대신 Supabase PostgreSQL을 사용하려면 다음 순서로 설정합니다.

1. Supabase 프로젝트의 `Connect`에서 Session pooler 연결 문자열을 복사합니다.
2. `apps/mock-api/.env.example`을 복사합니다.

   ```powershell
   Copy-Item apps/mock-api/.env.example apps/mock-api/.env.local
   ```

3. `apps/mock-api/.env.local`에 실제 연결 문자열을 입력합니다.

   ```env
   DATABASE_URL=postgresql://postgres.PROJECT_REF:비밀번호@REGION.pooler.supabase.com:5432/postgres
   ```

4. 스키마와 샘플 데이터를 준비합니다.

   ```powershell
   pnpm db:setup
   ```

5. 개발 서버를 시작합니다.

   ```powershell
   pnpm dev
   ```

`pnpm db:seed`는 사용자 테이블이 비어 있을 때만 샘플 데이터를 입력합니다. 실제 데이터가 있는 환경에서 `/api/v1/__mock/reset`은 기본적으로 차단됩니다.

데이터베이스 비밀번호가 포함된 `DATABASE_URL`은 GitHub, README, 프론트엔드 환경변수에 기록하지 않습니다.

## 네이버 지도와 장소 검색 연결

네이버 지도와 장소 검색은 서로 다른 인증 정보를 사용합니다.

### 1. 브라우저 지도

네이버 클라우드 플랫폼 Maps Application에서 Dynamic Map을 활성화하고 Client ID를 발급합니다.

```powershell
Copy-Item apps/web/.env.example apps/web/.env.local
```

`apps/web/.env.local`:

```env
VITE_API_URL=/api/v1
VITE_NAVER_MAP_CLIENT_ID=네이버_클라우드_지도_Client_ID
```

네이버 클라우드 콘솔의 Web 서비스 URL에 다음 주소를 등록합니다.

- 로컬: `http://127.0.0.1:5173`
- 배포: Render가 발급한 실제 HTTPS 주소

### 2. 서버 장소 검색

네이버 Developers에서 애플리케이션을 만들고 검색 API 권한을 추가합니다.

`apps/mock-api/.env.local`:

```env
NAVER_SEARCH_CLIENT_ID=네이버_검색_API_Client_ID
NAVER_SEARCH_CLIENT_SECRET=네이버_검색_API_Client_Secret
```

`NAVER_SEARCH_CLIENT_SECRET`에는 절대 `VITE_` 접두사를 붙이지 않습니다. `VITE_` 환경변수는 브라우저 빌드에 포함되므로 Secret을 넣으면 외부에 노출됩니다.

환경변수를 변경한 뒤에는 `pnpm dev`를 종료하고 다시 실행해야 합니다.

## 자주 사용하는 명령

| 명령 | 용도 |
| --- | --- |
| `pnpm dev` | 웹과 API를 함께 실행 |
| `pnpm dev:web` | 웹만 실행 |
| `pnpm dev:api` | API만 실행 |
| `pnpm typecheck` | 전체 TypeScript 타입 검사 |
| `pnpm test:api` | 메모리 저장소 기반 API 테스트 |
| `pnpm build:render` | Render 배포와 같은 방식으로 빌드 |
| `pnpm start` | Express 서버 시작 |
| `pnpm db:migrate` | 적용되지 않은 DB 마이그레이션 실행 |
| `pnpm db:seed` | DB가 비어 있을 때 샘플 데이터 입력 |
| `pnpm db:setup` | 마이그레이션 후 조건부 시드 실행 |

## Render 테스트 배포

루트의 `render.yaml`은 웹과 API를 하나의 Render Web Service로 배포합니다.

1. 작업 브랜치를 GitHub에 푸시합니다.
2. Render에서 `New > Blueprint`를 선택합니다.
3. `Riverwon2/DAMO` 저장소와 배포할 브랜치를 연결합니다.
4. Blueprint 경로로 `render.yaml`을 선택합니다.
5. 다음 환경변수를 Render에 입력합니다.

   | 환경변수 | 설명 |
   | --- | --- |
   | `DATABASE_URL` | Supabase Session pooler 연결 문자열 |
   | `VITE_NAVER_MAP_CLIENT_ID` | 네이버 클라우드 Dynamic Map Client ID |
   | `NAVER_SEARCH_CLIENT_ID` | 네이버 Developers 검색 API Client ID |
   | `NAVER_SEARCH_CLIENT_SECRET` | 네이버 Developers 검색 API Client Secret |

6. 배포 후 `/health`에서 `status: ok`, `storage: postgres`를 확인합니다.
7. 네이버 클라우드 Maps Application의 Web 서비스 URL에 Render 주소를 추가합니다.

Render는 빌드 후 다음 순서로 서버를 시작합니다.

```text
DB 마이그레이션 → DB가 비어 있으면 샘플 데이터 입력 → Express 서버 시작
```

Render 무료 인스턴스는 일정 시간 사용하지 않으면 중지될 수 있어 첫 요청이 느릴 수 있습니다.

## 개발 시 역할과 소통 기준

코드를 수정하기 전에 어느 문서가 기준인지 먼저 확인합니다.

| 결정하려는 내용 | 기준 문서 | 담당 관점 |
| --- | --- | --- |
| 사용자가 어떤 화면으로 이동하는가 | [`docs/flow.md`](docs/flow.md) | 기획·UX |
| 어떤 데이터를 저장하는가 | [`docs/data-model.md`](docs/data-model.md) | 백엔드·DB |
| 프론트엔드가 어떤 요청을 보내는가 | [`docs/openapi.yaml`](docs/openapi.yaml) | 프론트·백엔드 공통 |
| API의 설명과 예외 규칙 | [`docs/api.md`](docs/api.md) | 개발 협업 |
| Supabase 연결과 테이블 운영 | [`docs/database.md`](docs/database.md) | 백엔드·배포 |
| 로컬 실행과 지도 설정 | [`docs/local-development.md`](docs/local-development.md) | 모든 개발자 |

프론트엔드와 백엔드의 경계는 다음처럼 구분합니다.

- 프론트엔드는 화면 상태, 입력 검증, API 호출, 오류 표시를 담당합니다.
- API 서버는 권한, 정원, 후보 2개 제한, 투표 상태 같은 최종 규칙을 다시 검사합니다.
- 공통 문자열과 데이터 형태는 `packages/contracts`에서 공유합니다.
- DB 스키마를 바꿀 때는 `apps/mock-api/migrations`에 새 마이그레이션을 추가합니다.
- 프론트엔드 코드에서 Supabase 연결 문자열이나 서버 Secret을 사용하지 않습니다.
- 화면 흐름이 바뀌면 `flow.md`, 데이터가 바뀌면 `data-model.md`, 요청 형식이 바뀌면 `openapi.yaml`을 코드와 함께 수정합니다.

프론트엔드 개발자에게 기능을 전달할 때는 아래 네 가지를 함께 공유하면 됩니다.

1. 시작 화면과 완료 화면
2. 사용자가 누르는 버튼과 화면 전환
3. 필요한 API 경로와 요청·응답 예시
4. 로딩, 빈 상태, 권한 없음, 최대 개수 초과 같은 예외 처리

## 권장 Git 작업 흐름

기능 하나를 브랜치 하나로 관리합니다.

```powershell
git switch main
git pull
git switch -c codex/기능이름
```

작업 후에는 관련 파일만 선택해 커밋합니다.

```powershell
git status
git add README.md apps/web/src/pages.tsx
git commit -m "기능 설명"
git push -u origin codex/기능이름
```

`git add .`보다는 변경 목적에 맞는 파일을 명시하는 편이 안전합니다. 개인 발표 자료, 임시 폴더, 환경변수 파일은 기능 커밋에 포함하지 않습니다.

## 문제 해결

### `127.0.0.1 refused to connect`

개발 서버가 실행 중이 아니거나 다른 포트로 실행된 상태입니다.

```powershell
pnpm dev
```

터미널의 Vite `Local` 주소를 확인합니다. 5173이 사용 중이면 5174로 실행될 수 있습니다.

### API 주소에서 `ROUTE_NOT_FOUND`가 표시됨

`http://127.0.0.1:4010`은 API 서버 주소입니다. 웹 화면은 `http://127.0.0.1:5173`으로 접속합니다. API 서버 확인에는 `/health`를 사용합니다.

### 실제 네이버 지도 대신 목 지도가 표시됨

다음을 확인합니다.

- `apps/web/.env.local`의 `VITE_NAVER_MAP_CLIENT_ID`
- 네이버 클라우드 콘솔에 등록한 Web 서비스 URL
- 환경변수 변경 후 개발 서버 재시작 여부

### 지도는 보이지만 장소 검색이 실패함

다음을 확인합니다.

- `apps/mock-api/.env.local`의 `NAVER_SEARCH_CLIENT_ID`
- `NAVER_SEARCH_CLIENT_SECRET`
- 네이버 Developers 애플리케이션의 검색 API 권한

### `DATABASE_URL이 설정되지 않았습니다`

Supabase를 사용하려는 경우 `apps/mock-api/.env.local`에 Session pooler 연결 문자열을 입력합니다. 메모리 저장소만 사용할 경우 `pnpm db:setup`을 실행하지 않고 바로 `pnpm dev`를 실행합니다.

### Render에서 지도가 보이지 않음

Render 환경변수에 `VITE_NAVER_MAP_CLIENT_ID`가 있어야 하며, 값을 변경한 뒤에는 새 빌드가 필요합니다. 네이버 클라우드 Maps Application에도 Render HTTPS 주소를 등록해야 합니다.

## 현재 MVP에서 남은 작업

- 실제 카카오·네이버·구글 OAuth 검증
- 운영용 Access Token·Refresh Token 정책
- API 요청 제한과 보안 로그
- 장소 이미지와 상세 정보 제공 범위 개선
- 5초 폴링을 WebSocket 또는 Server-Sent Events로 전환
- 모바일 접근성, 키보드 탐색, 다양한 기기 회귀 테스트 확대
- PostgreSQL 저장소의 나머지 변경 작업을 개별 SQL로 전환

## 문서 읽는 순서

처음 참여한 개발자는 다음 순서로 읽는 것을 권장합니다.

1. 이 README
2. [`docs/flow.md`](docs/flow.md)
3. [`docs/data-model.md`](docs/data-model.md)
4. [`docs/api.md`](docs/api.md)
5. [`docs/openapi.yaml`](docs/openapi.yaml)
6. [`docs/local-development.md`](docs/local-development.md)
7. [`docs/database.md`](docs/database.md)

기획 변경은 화면 흐름부터 확정하고, 데이터 모델과 API 계약을 수정한 뒤 코드를 변경합니다. 화면과 서버가 동시에 바뀌는 기능일수록 이 순서를 지키는 편이 재작업을 줄입니다.
