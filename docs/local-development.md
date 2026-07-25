# DAMO 로컬 개발 가이드

DAMO 프로토타입은 모바일 웹 프론트엔드와 메모리 기반 목 API 서버로 구성됩니다. 별도의 데이터베이스나 외부 지도 키가 없어도 전체 흐름을 실행할 수 있습니다.

## 1. 준비 사항

- Node.js 20 이상
- pnpm 11 이상

프로젝트 루트에서 의존성을 설치합니다.

```bash
pnpm install
```

## 2. 실행

프론트엔드와 목 API를 함께 실행합니다.

```bash
pnpm dev
```

기본 접속 주소는 다음과 같습니다.

- 모바일 웹: `http://127.0.0.1:5173`
- 목 API: `http://127.0.0.1:4010`
- API 상태 확인: `http://127.0.0.1:4010/health`

5173 포트를 이미 다른 프로그램이 사용 중이면 Vite가 5174 같은 다음 포트를 자동으로 선택합니다. 터미널에 표시된 `Local` 주소로 접속하면 됩니다.

## 3. 테스트 계정

로그인 화면에서 다음 계정을 바로 사용할 수 있습니다.

| 아이디 | 비밀번호 | 닉네임 |
| --- | --- | --- |
| `damo` | `1234` | 가은 |
| `minsu` | `1234` | 민수 |
| `jiyun` | `1234` | 지윤 |

카카오, 네이버, 구글 버튼도 프로토타입용 OAuth 흐름으로 동작합니다. 실제 제공자 인증이나 계정 통합은 아직 연결하지 않았습니다.

## 4. 지도 설정

지도 키를 설정하지 않으면 샘플 장소가 표시되는 로컬 목 지도를 사용합니다. 따라서 기능 확인에는 별도 토큰이 필요하지 않습니다.

실제 네이버 지도를 확인하려면 `apps/web/.env.example`을 `apps/web/.env.local`로 복사한 뒤 값을 입력합니다.

```env
VITE_API_URL=http://127.0.0.1:4010/api/v1
VITE_NAVER_MAP_CLIENT_ID=네이버_지도_클라이언트_ID
```

`VITE_NAVER_MAP_CLIENT_ID`에는 Access Token이 아니라 네이버 클라우드 플랫폼의 지도용 Client ID를 입력합니다. 환경변수를 바꾼 뒤에는 개발 서버를 다시 시작해야 합니다.

## 5. 샘플 데이터 초기화

목 API의 데이터는 서버 메모리에만 저장됩니다. 서버를 재시작하거나 아래 요청을 보내면 최초 샘플 상태로 돌아갑니다.

```bash
curl -X POST http://127.0.0.1:4010/api/v1/__mock/reset
```

초기 샘플에는 후보 선택 중인 모임, 투표 중인 모임, 완료된 모임이 각각 포함되어 있습니다. 가입 화면을 확인할 때는 코드 `4821`을 사용할 수 있습니다.

## 6. 검사 명령

```bash
pnpm typecheck
pnpm test:api
pnpm build
```

- `typecheck`: 프론트엔드, 목 API, 공용 타입 검사
- `test:api`: 홈 조회, 모임 생성, N-1회 투표와 알림 해제를 포함한 API 테스트
- `build`: 배포용 프론트엔드와 서버 코드 빌드

## 7. 현재 프로토타입의 범위

- 로그인 정보와 비밀번호는 목 서버 메모리에만 존재합니다.
- 새로 만든 모임, 내 장소, 투표 결과는 서버를 재시작하면 사라집니다.
- 실제 배포 서버에서는 비밀번호 해시, 영구 데이터베이스, OAuth 제공자 검증, 접근 토큰 갱신, 요청 제한과 로그 처리가 추가로 필요합니다.
- 결과 화면은 현재 5초 간격 조회 방식입니다. 사용량이 늘면 WebSocket 또는 Server-Sent Events로 교체할 수 있습니다.
- API 계약의 기준 문서는 `docs/openapi.yaml`이며, 화면·규칙의 기준은 `docs/flow.md`와 `docs/data-model.md`입니다.

## 8. Render 통합 테스트 배포

루트의 `render.yaml`은 Vite 웹 빌드와 Express 목 API를 하나의 Render Web Service로 배포합니다. 배포 환경에서는 웹과 API가 동일한 도메인을 사용하므로 별도의 CORS 주소 설정이 필요하지 않습니다.

1. 변경사항을 GitHub에 푸시합니다.
2. Render Dashboard에서 `New > Blueprint`를 선택합니다.
3. GitHub의 `Riverwon2/DAMO` 저장소를 연결합니다.
4. 테스트 중에는 `codex/add-development-docs`, PR 병합 후에는 `main` 브랜치를 선택합니다.
5. Blueprint Path가 `render.yaml`인지 확인합니다.
6. 생성될 서비스와 요금제를 확인한 뒤 `Deploy Blueprint`를 선택합니다.
7. 배포가 끝나면 Render가 발급한 `https://...onrender.com` 주소를 모바일 브라우저에서 엽니다.

실제 네이버 지도를 사용할 때는 Render 서비스의 Environment에 `VITE_NAVER_MAP_CLIENT_ID`를 추가하고 다시 빌드합니다. 네이버 클라우드 Maps Application의 Web 서비스 URL에도 Render에서 발급된 호스트 주소를 등록해야 합니다.

통합 배포를 로컬에서 미리 확인하려면 다음 순서로 실행합니다.

```bash
pnpm build:render
```

Windows PowerShell:

```powershell
$env:DAMO_SERVE_WEB = "true"
$env:DAMO_HOST = "127.0.0.1"
$env:PORT = "4010"
pnpm start
```

macOS 또는 Linux:

```bash
DAMO_SERVE_WEB=true DAMO_HOST=127.0.0.1 PORT=4010 pnpm start
```

이 모드에서는 웹과 API를 모두 `http://127.0.0.1:4010`에서 확인합니다. 목 데이터는 Render 인스턴스가 재시작되거나 새 버전이 배포될 때 초기화됩니다.
