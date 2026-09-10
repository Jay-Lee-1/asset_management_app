---
name: app-evolve
description: This skill should be used when the user runs "/app-evolve", asks to "앱을 자동으로 발전시켜", "매 시간마다 앱 개선해줘", "auto-evolve this app", or wants the current project to be improved unattended over repeated cycles without re-explaining what to do each time. Rotates through four phases — develop, review, critique, advance — using state saved in the target project so each run continues where the last one left off.
---

# App Evolve — 4단계 로테이션 자동 개선 스킬

현재 작업 디렉토리(cwd)에 있는 프로젝트를 대상으로, 호출될 때마다 "발전(develop) → 검토(review) → 비평(critique) → 고도화(advance)" 중 정확히 한 단계만 수행하고 다음 단계로 넘어간다. `/loop 60m /app-evolve`와 함께 쓰면 사용자가 매번 요청하지 않아도 한 시간에 한 번씩 앱이 조금씩 더 나아진다.

이 스킬은 대상 프로젝트에 **직접 커밋을 만든다**. 처음 도입하는 프로젝트에서는 반드시 수동으로 2~3 사이클을 눈으로 확인한 뒤에 `/loop`로 무인 실행을 맡길 것.

## 0. 사전 점검 (매 호출 시 항상)

1. `git rev-parse --is-inside-work-tree`로 cwd가 git 저장소인지 확인한다. 아니면 즉시 중단하고 사용자에게 프로젝트 폴더로 이동한 뒤 다시 실행하라고 안내한다.
2. `git status --porcelain`으로 커밋되지 않은 변경사항이 있는지 확인한다. 이 스킬이 만든 것이 아닌 미완성 작업으로 보이면(직전 사이클 종료 시점에 clean 상태였어야 함) **진행하지 말고** 사용자에게 알린다. 사용자의 진행 중인 작업을 덮어쓰지 않는다.
3. 상태 파일은 저장소 루트의 `app-evolve-state.json`이다 (**`.claude/` 아래에 두지 않는다** — 클라우드 실행 환경이 `.claude/` 경로를 "민감한 파일"로 취급해 쓰기 전에 사람 승인을 요구하는데, 무인 루틴에는 승인할 사람이 없어 그 자리에서 영원히 멈춘다. 실제로 이 문제로 클라우드 루틴이 멈춘 적이 있다). 없으면 아래 스키마로 새로 만들고 `phase: "develop"`, `cycle: 0`부터 시작한다.

```json
{
  "cycle": 0,
  "phase": "develop",
  "pending_advance_plan": null,
  "history": []
}
```

`history`는 최근 20개 항목만 유지한다(오래된 항목은 앞에서 잘라낸다). 각 항목: `{ "cycle": n, "phase": "...", "timestamp": "...", "summary": "...", "commit": "<sha 또는 null>" }`.

이 파일은 **git에 커밋된 상태로 유지한다** (아래 2-3 참고). 클라우드 루틴은 매 실행마다 완전히 새로운 컨테이너에 저장소를 새로 클론하므로, 커밋되지 않은 로컬 전용 상태는 다음 실행에서 그냥 사라진다 — git이 유일하게 실행 간에 실제로 이어지는 저장소다. state.json을 못 찾으면 `git log --oneline -5`의 최근 `[app-evolve:...]` 커밋 메시지로 마지막 단계를 추정해 다음 단계부터 이어가고(예: 마지막이 `develop`이면 `review`부터), cycle 번호를 모르면 0으로 시작해도 된다 — 완벽히 못 맞춰도 로테이션이 죽는 것보다 낫다.

4. 프로젝트에 build/lint/test 스크립트가 있는지 확인한다(`package.json`의 scripts, Makefile, CLAUDE.md 등). 있으면 각 단계 끝에 실행해서 검증한다.

## 1. 단계별 절차

한 번의 호출에서는 `state.phase`에 해당하는 절차 **하나만** 수행한다. 다른 단계를 미리 하지 않는다.

### develop (발전)

목표: 작지만 실제로 가치 있는 개선 하나를 찾아 끝까지 구현한다.

- `history`에서 최근 develop/advance 항목을 훑어 이미 다룬 내용과 겹치지 않게 한다.
- 코드베이스를 탐색해 버그 수정, 누락된 엣지 케이스 처리, 작은 기능, UX 다듬기, 누락된 테스트 등 한 사이클 안에 안전하게 끝낼 수 있는 항목 하나를 고른다. 여러 개를 동시에 벌리지 않는다.
- 끝까지 구현한다(코드 + 필요하면 테스트).
- build/lint/test가 있으면 실행하고 실패하면 고친다. 합리적인 시도 후에도 실패하면 변경을 되돌리고(`git checkout -- <files>`) 이번 사이클은 "실패, 다음에 재시도"로 기록한다.
- 성공하면 커밋한다. 커밋 메시지 접두어: `[app-evolve:develop] `.

### review (검토)

목표: 방금 전 develop 단계에서 만든 변경(또는 아직 리뷰 안 된 가장 최근 커밋들)을 냉정하게 검사한다.

- `git log`/`git diff`로 마지막 develop 커밋 이후의 변경을 확인한다.
- 정확성, 엣지 케이스, 에러 처리, 기존 코드와의 일관성을 중심으로 검토한다. 필요하면 `code-review` 스킬을 medium 수준으로 이 diff에 대해 호출해도 된다.
- 실제 버그를 발견하면 그 자리에서 작은 범위로 고치고 커밋한다(`[app-evolve:review] fix: ...`, state.json 갱신도 같은 커밋에 포함). 고칠 만큼 급하지 않은 지적사항은 코드는 커밋하지 말고 `history`의 summary에 기록만 남겨 critique 단계가 참고하게 한다.
- 코드 변경이 없으면(문제 없음) "이상 없음"으로 기록하되, state.json 갱신만 담은 작은 커밋은 만든다(`[app-evolve:review] no issues found`).

### critique (비평)

목표: 최근 커밋 하나가 아니라 앱 전체를 한 걸음 물러나서 비판적으로 본다. develop/review보다 더 크고 전략적인 시야로 본다.

- 아키텍처, UX 흐름, 기술 부채, 성능, 빠진 제품 기능, 일관성 없는 패턴, 접근성, 에러 상태 등을 살핀다.
- 다음 advance 단계에 투입할 가치가 있는 **가장 우선순위 높은 약점 하나**를 고른다. 사소한 것은 여기서 고치지 않는다(고치는 건 develop/review의 몫).
- 이 단계에서는 코드를 크게 건드리지 않는다. 대신 구체적이고 실행 가능한 계획을 세워 `state.pending_advance_plan`에 저장한다: `{ "title": "...", "why": "...", "approach": "..." }`.
- 코드 변경은 없지만, state.json은 이제 항상 커밋해야 하므로(2-3 참고) critique도 `app-evolve-state.json` 갱신만 담는 작은 커밋을 만든다(`[app-evolve:critique] plan: ...`). 코드 diff는 비어 있는 게 정상이다.

### advance (고도화)

목표: critique 단계가 세워둔 계획을 실제로 구현해 앱을 한 단계 끌어올린다. develop보다 범위가 커도 된다(의미 있는 리팩터링, 기능 확장 등).

- `state.pending_advance_plan`을 읽는다. 없으면(첫 사이클 등) `history`에서 가장 최근 critique 항목을 대신 사용한다. 그마저 없으면 이번 사이클은 develop과 같은 방식으로 개선점 하나를 골라 처리한다.
- 계획을 끝까지 구현한다. build/lint/test 실행 및 실패 시 수정, 안 되면 되돌리기는 develop과 동일한 규칙을 따른다.
- 성공하면 커밋한다(`[app-evolve:advance] `). `state.pending_advance_plan`을 `null`로 비운다.

## 2. 사이클 마무리 (매 호출 종료 시 항상)

1. 이번 단계의 결과를 `history`에 append하고 20개 넘으면 오래된 것부터 자른다.
2. 단계를 다음으로 회전시킨다: develop → review → critique → advance → develop. `advance`에서 `develop`으로 돌아갈 때만 `cycle`을 1 증가시킨다.
3. `app-evolve-state.json`을 저장하고 **반드시 커밋한다**(코드 변경이 있었으면 같은 커밋에 포함, 코드 변경이 없었으면 state.json만 담은 별도의 작은 커밋). 클라우드 루틴은 매번 새 컨테이너에서 시작해 커밋된 것만 이어받을 수 있으므로, 이 커밋을 건너뛰면 다음 실행이 로테이션 위치를 잃는다.
4. 사용자에게 짧게 보고한다: 이번에 어떤 단계를 수행했는지, 무엇을 했는지/찾았는지 1~3문장, 커밋 해시(있으면), 다음 단계가 무엇인지.

## 3. 안전 규칙 (항상 지킨다)

- **클라우드 루틴으로 실행 중이라면, 이 저장소(origin)에는 커밋을 push해도 된다** — 이게 유일한 지속 경로이기 때문이다. 그 외의 원격(fork, 다른 저장소)에는 절대 push하지 않는다. PR을 열거나, CI/CD 설정을 건드리거나, 원격 상태에 영향을 주는 다른 어떤 것도 사용자가 명시적으로 요청하지 않는 한 하지 않는다.
- 사이클 하나당 diff는 작고 리뷰 가능한 크기로 유지한다. 한 번에 여러 개선을 몰아넣지 않는다.
- 실패한 빌드/테스트를 커밋한 채로 남기지 않는다. 고치지 못하면 되돌리고 실패로 기록한다.
- 스킬이 만들지 않은 미완성 변경사항이 있으면 절대 진행하지 말고, 커밋하지 말고 그대로 둔다(0-2 참고). 클라우드 루틴에서는 사용자에게 직접 물어볼 수 없으므로, 이 경우 아무 것도 하지 않고 state.json에 "블로킹됨: 미완성 변경사항 발견"이라고만 기록하고 종료한다.
- 프로젝트에 이미 있는 컨벤션(린트 설정, 커밋 메시지 스타일, 테스트 프레임워크, CLAUDE.md 지침)을 그대로 따른다.
- 근거 없이 파괴적인 리팩터링(대규모 삭제, 의존성 대거 교체 등)을 벌이지 않는다. 고도화도 "다음 걸음"이지 "재작성"이 아니다.
- 이 프로젝트는 서버 없는 단일 HTML 파일 기반 PWA다(`our-assets-v1.14.1/our-assets/index.html`). 별도의 build/lint/test 스크립트가 없으므로, JS 문법 검증은 `<script>` 블록을 추출해 `node --check`로 확인하는 방식을 쓴다. HTML/JS를 수정했다면 `our-assets-v1.14.1/our-assets/sw.js`의 `CACHE` 버전과 `index.html`의 `APP_VERSION`을 함께 올려 배포 시 캐시가 갱신되게 한다.

## 4. 무인 실행 설정 방법

이 스킬 자체는 한 번 호출되면 한 단계만 수행하고 끝난다. 반복 실행은 로컬 세션에서는 `loop` 스킬이, 세션 없이도 도는 무인 실행은 클라우드 루틴(`schedule` 스킬, `RemoteTrigger`)이 담당한다.
