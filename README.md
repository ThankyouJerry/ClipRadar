# ClipRadar MVP

ClipRadar는 방송 VOD에서 채팅 밀도와 키워드 급증을 분석해 하이라이트 후보를 보여주는 로컬 MVP입니다.
샘플 리포트에는 클립 반응 지표도 포함되어 있지만, 현재 실제 치지직 VOD 분석은 채팅/키워드 기반으로 동작합니다.
클립 데이터 연결은 다음 단계에서 보강할 예정입니다.

## 목표

- 정적인 주간 리포트보다 더 탐색적인 하이라이트 맵을 만든다.
- 각 하이라이트에 "왜 이 구간이 뜨거웠는지" 설명 가능한 근거를 붙인다.
- ClipCatcher와 이어질 수 있도록 구간 정보와 내보내기 JSON을 유지한다.

## 실행

```bash
python3 server.py
```

브라우저에서 열기:

```text
http://localhost:5173
```

## MVP 기능

- 치지직 VOD URL 입력 후 다시보기 채팅 빠른 샘플링 기반 자동 분석
- 여러 VOD URL 입력 후 주간 묶음 하이라이트 분석
- 빠른 분석/정밀 분석 모드 선택
- 스트리머별 주간 리포트 선택
- 종합 하이라이트 점수, 채팅 급증도, 클립 영향도 기준 TOP 하이라이트 정렬
- 같은 VOD 내부의 평소 구간 대비 채팅 급증 기반 Moment Map
- 하이라이트 선정 이유 표시
- 치지직 스트리머 프로필 이미지 표시
- 하이라이트 타입, 타입 신뢰도, 근거 키워드 표시
- 대표 채팅 샘플 표시
- 후보 고정/제외 관리
- ClipCatcher 가져오기용 JSON 내보내기
- 편집자 작업표 CSV 내보내기
- 편집자 HTML 작업표 내보내기
- 주간 HTML 리포트 내보내기

## 현재 분석 범위

- 실제 VOD 분석: 치지직 다시보기 채팅과 반응 키워드 기반
- 샘플 리포트: 채팅/키워드/클립 지표가 함께 있는 데모 데이터
- 향후 보강: 실제 치지직 클립 데이터 연결, 프레임/썸네일 미리보기, 별도 패키징

GitHub Pages는 정적 소개/문서 사이트입니다. 새 VOD 분석은 로컬에서 `python3 server.py`를 실행한 뒤 브라우저에서 진행합니다.

## JSON 구조

ClipRadar의 기본 데이터 계약은 `clipradar.report.v1`입니다.

핵심 필드:

```json
{
  "schemaVersion": "clipradar.report.v1",
  "video": {
    "url": "https://chzzk.naver.com/video/123456",
    "title": "VOD 제목"
  },
  "videos": [
    {
      "id": "123456",
      "url": "https://chzzk.naver.com/video/123456",
      "title": "VOD 제목"
    }
  ],
  "streamer": {
    "name": "스트리머명",
    "channelId": "채널 ID",
    "profileImageUrl": "https://...",
    "channelUrl": "https://chzzk.naver.com/..."
  },
  "review": {
    "pinnedIds": ["123456-1230-1320"],
    "excludedIds": [],
    "excludedOmitted": true
  },
  "moments": [
    {
      "rank": 1,
      "reviewStatus": "pinned",
      "reviewStatusLabel": "고정",
      "title": "하이라이트 제목",
      "url": "https://chzzk.naver.com/video/123456",
      "videoTitle": "VOD 제목",
      "highlightType": "funny_reaction",
      "highlightTypeLabel": "웃긴 리액션",
      "highlightTypeConfidence": 88,
      "evidenceKeywords": [
        { "keyword": "ㅋㅋ", "count": 42 },
        { "keyword": "개웃", "count": 7 }
      ],
      "representativeChats": [
        {
          "time": "00:20:38",
          "message": "ㅋㅋㅋㅋㅋㅋ",
          "matchedKeywords": ["ㅋㅋ"]
        }
      ],
      "mergedSegmentCount": 3,
      "startTimeSeconds": 1230,
      "endTimeSeconds": 1320,
      "coreStartTimeSeconds": 1230,
      "coreEndTimeSeconds": 1320,
      "cutStartTimeSeconds": 1200,
      "cutEndTimeSeconds": 1380,
      "preRollSeconds": 30,
      "postRollSeconds": 60,
      "reason": "선정 이유",
      "metrics": {
        "radarScore": 88.5,
        "chatSpike": 4.2,
        "keywordSpike": 3.1
      }
    }
  ]
}
```

`startTimeSeconds`와 `endTimeSeconds`는 채팅 반응이 실제로 튄 핵심 반응 구간입니다.
`cutStartTimeSeconds`와 `cutEndTimeSeconds`는 편집자가 바로 확인하기 쉽도록 앞 30초, 뒤 60초를 붙인 추천 컷 범위입니다.

`streamer.profileImageUrl`은 치지직 VOD 메타데이터의 `channel.channelImageUrl`에서 가져온 스트리머 프로필 이미지입니다.

현재 하이라이트 타입은 채팅 키워드 기준으로 `웃긴 리액션`, `고점 리액션`, `놀람/사건`, `채팅 급증` 중 하나로 우선 분류합니다.
`highlightTypeConfidence`는 해당 타입을 뒷받침하는 키워드 비중을 0-100%로 표시한 값입니다.
`evidenceKeywords`는 타입 분류와 점수에 영향을 준 반응 키워드 목록이고, `representativeChats`는 편집자가 맥락을 빨리 확인할 수 있는 실제 채팅 샘플입니다.

`mergedSegmentCount`는 가까운 30초 후보가 몇 개 합쳐졌는지 나타냅니다. 같은 VOD 안에서 90초 이내로 이어지는 후보는 최대 3분까지 하나의 연속 반응 구간으로 병합됩니다.

`reviewStatus`는 후보 검토 상태입니다. `pinned`는 좋은 후보라 위로 고정한 항목, `excluded`는 내보내기에서 제외할 항목, `candidate`는 아직 검토 중인 기본 후보입니다. ClipCatcher용 JSON, CSV, HTML 내보내기는 제외 항목을 기본으로 빼고 저장합니다.

## 지표 기준

### 채팅 급증도

```text
전체 분석: 구간 분당 채팅량 / 해당 VOD 전체 평균 분당 채팅량
빠른·정밀 분석: 구간의 샘플 채팅량 / 수집된 샘플 내 기준 채팅량
```

단순 채팅 수가 아니라 같은 VOD 안에서 다른 구간보다 얼마나 튀었는지 봅니다. 빠른·정밀 분석의 값은 전체 채팅을 모두 센 절대 통계가 아니라, VOD 전역에서 수집한 샘플 안의 상대 지표입니다.

### 클립 영향도

```text
클립 조회 영향 60% + 클립 생성 밀도 40%
```

`클립 조회 영향`은 구간 주변 클립 조회수 확산, `클립 생성 밀도`는 구간 주변 클립 생성 빈도입니다.
현재 실제 VOD 분석에서는 클립 API가 아직 연결되지 않았으므로 이 값은 샘플 리포트 기준으로만 의미가 있습니다.

### 실제 VOD 종합 하이라이트 점수

```text
채팅 급증도 70% + 키워드 급증도 30%
```

현재 실제 VOD 분석은 채팅 데이터만 사용하므로, 존재하지 않는 클립 신호를 점수에 넣지 않습니다.

### 샘플 리포트 종합 하이라이트 점수

```text
채팅 급증도 40%
+ 클립 조회 영향 25%
+ 클립 생성 밀도 20%
+ 키워드 급증도 15%
```

샘플 리포트에서만 실시간 반응, 팬이 직접 자른 빈도, 잘린 클립의 소비량, 키워드 급증을 함께 봅니다.

### 레이더 신뢰도

```text
채팅·키워드 신호 강도 평균 × (75% + 두 신호 일치도 25%)
```

레이더 신뢰도는 선택된 후보에서 채팅 급증과 반응 키워드 급증이 함께 강하고 비슷한 수준으로 나타나는지 보여줍니다. 실제 클립 데이터가 연결되기 전까지 클립 신호는 신뢰도에 포함하지 않습니다.

```text
90% 이상: 강한 후보
75-89%: 좋은 후보
60-74%: 검토 후보
60% 미만: 보조 데이터가 더 필요
```

## ClipCatcher용 JSON 내보내기 활용

ClipCatcher용 JSON은 사람이 읽는 리포트가 아니라 ClipCatcher가 다시 읽을 수 있는 구간 데이터 파일입니다.

- ClipCatcher가 시작/종료 시간을 읽어 하이라이트 구간만 다운로드할 수 있습니다.
- ClipCatcher는 추천 컷 범위가 있으면 `cutStartTimeSeconds`와 `cutEndTimeSeconds`를 우선 사용합니다.
- ClipCatcher용 JSON 내보내기는 고정 후보를 먼저 정렬하고 제외 후보는 기본으로 생략합니다.
- 주간 JSON에서는 각 하이라이트의 `moment.url`을 읽어 서로 다른 VOD 구간도 다운로드할 수 있습니다.
- 편집자가 TOP 구간, 점수, 선정 이유를 작업표로 정리할 수 있습니다.
- 주간 HTML 리포트나 블로그 글을 같은 데이터로 다시 생성할 수 있습니다.

## GitHub Pages 정적 사이트

`docs/` 폴더에는 GitHub Pages용 정적 소개 사이트가 들어 있습니다.

- `docs/index.html`: ClipRadar 소개
- `docs/sample-report.html`: 실제 풀스캔 리포트 예시
- `docs/usage.html`: 사용법
- `docs/integration.html`: 다운로드 및 ClipCatcher 연동 안내

GitHub Pages 설정에서 `main` 브랜치의 `/docs` 폴더를 선택하면 여러 페이지로 나눠 볼 수 있습니다. 이 사이트는 소개/문서/정적 리포트 공유용이며, 실제 VOD 분석은 로컬 앱에서 수행합니다.

## 분석 방식

기본 분석은 `chat-sampled` 모드입니다. 긴 VOD의 모든 채팅 페이지를 처음부터 끝까지 받으면 몇 분 이상 걸릴 수 있어서, VOD 전체 구간에서 대표 채팅 페이지를 병렬로 샘플링한 뒤 상대적으로 반응이 강한 구간을 찾습니다.

따라서 빠른·정밀 분석의 채팅 수와 급증 배수는 전체 채팅의 완전한 집계가 아니라 샘플 기준 추정값입니다. 전체 수치가 필요한 경우 `full` 모드를 사용해야 합니다.

빠른 분석은 샘플 지점을 적게 써서 후보를 빨리 찾는 모드입니다. 정밀 분석은 더 많은 샘플 지점을 사용해서 긴 방송의 중간 구간을 놓칠 가능성을 줄입니다. 정밀 분석은 더 오래 걸릴 수 있습니다.

분석은 먼저 30초 단위 후보를 만들고, 같은 VOD 안에서 90초 이내로 이어지는 후보를 최대 3분 길이의 하나의 하이라이트로 병합합니다. 이렇게 하면 같은 장면이 여러 카드로 쪼개지는 문제를 줄이고, ClipCatcher로 가져갈 때도 한 장면이 하나의 다운로드 범위로 정리됩니다.

여러 링크를 넣으면 `weekly-chat-sampled` 모드로 동작합니다. 각 VOD를 자기 평균 기준으로 먼저 분석한 뒤, 후보 구간을 한데 모아 주간 TOP 하이라이트로 정렬합니다. 긴 방송 하나가 단순 채팅량 때문에 무조건 이기지 않도록 VOD별 상대 점수를 유지합니다.

이 방식은 빠른 하이라이트 후보 탐색에 적합합니다. 전체 채팅 아카이빙이 필요하면 이후 `full` 모드 또는 별도 채팅 캐시 기능으로 확장할 수 있습니다.

## 다음 단계

- 실제 Chzzk 클립 데이터 연결
- VOD 썸네일 및 미리보기 프레임 표시
- ClipCatcher 구간 다운로드 버튼 연결
- 키워드 사전 확장 및 스트리머별 표현 학습
- 정적 HTML 리포트 생성 CLI 추가

## License

MIT License
