# KORMo-Web 크롬 확장 프로그램

[KAIST MLP Lab](https://sites.google.com/view/aailab)에서 개발한 한국어 웹 특화 GUI 에이전트 KORMo-Web의 크롬 확장 프로그램입니다.
크롬 사이드 패널에서 직접 작업을 지시하거나, 디스코드 봇을 통해 원격으로 웹을 조작하실 수 있습니다.

공개된 모델은 [허깅페이스](https://huggingface.co/collections/KORMo-VL/kormo-web)에서 확인하실 수 있습니다.

## 준비물

- 크롬 116 버전 이상
- 모델을 실행할 애플 실리콘 맥(M5 권장) 또는 GPU 서버 한 대. 아래 1단계에서 두 가지 방법 중 하나를 선택하시면 됩니다.
- 맥에서 직접 실행하신다면 메모리에 맞춰 모델을 고르시면 됩니다. 4B 4비트는 16GB 이상, 4B 원본은 24GB 이상, 9B 원본은 48GB 이상을 권장합니다(아래 표 참고).

## 1단계. 모델 서버 실행

모델을 띄우는 방법은 두 가지이고, 둘 중 한 가지만 진행하시면 됩니다.

| 방법 | 필요한 장비 | 특징 |
|---|---|---|
| 맥에서 직접 실행 | 애플 실리콘 맥 | 맥 한 대로 끝낼 수 있지만 속도는 느린 편입니다 |
| GPU 서버에서 실행 | vLLM을 띄울 GPU 서버 | 훨씬 빠르고, 여러 사람이 한 서버를 함께 쓸 수 있습니다 |

화면 이미지가 포함된 요청은 특히 느리기 때문에, 가볍게 시험해 보시는 경우가 아니라면 GPU 서버를 권해 드립니다.

### 방법 1. 맥에서 직접 실행하기 (MLX)

애플 실리콘 맥이 필요합니다. 

```bash
uname -m
```

`arm64`가 출력되면 진행하셔도 됩니다. `x86_64`가 출력된다면 인텔 맥이므로 이 방법으로는 모델 서버를 로컬에서 띄울 수 없습니다.

맥 메모리에 맞춰 아래 세 모델 중 하나를 고르시면 됩니다. 세 모델 모두 같은 명령으로 실행되며, `MODEL=` 한 줄만 바꾸시면 됩니다.

| 모델 (`MODEL=`) | 가중치 파일 | 실제 사용 메모리 | 권장 맥 메모리 |
|---|---:|---:|---|
| `KORMo-Web-4B-mlx-4bit` (4비트 양자화) | 2.8GB | 약 3.8GB | 16GB 이상 |
| `KORMo-Web-4B` (원본) | 9.6GB | 약 9.5GB | 24GB 이상 |
| `KORMo-Web-9B` (원본) | 17.5GB | 약 19GB | 48GB 이상 (32GB는 빠듯함) |

실제 사용 메모리는 vllm-mlx 0.6.0으로 띄워 짧은 요청을 몇 번 보낸 직후 잰 값입니다. 대화가 길어지면 늘어나고(3만 토큰에 약 1GB), 크롬도 함께 메모리를 쓰므로 권장 메모리를 지켜 주세요.

```bash
# 0. uv 설치
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.zshrc

# 1. 환경 만들기
mkdir mlx-serve && cd mlx-serve
uv venv --python 3.12
source .venv/bin/activate
uv pip install "vllm-mlx>=0.6.0" huggingface_hub

# 2. 모델 고르기 (셋 중 하나)
MODEL=KORMo-Web-4B-mlx-4bit      # 16GB 이상
# MODEL=KORMo-Web-4B             # 24GB 이상
# MODEL=KORMo-Web-9B             # 48GB 이상

# 3. 모델 다운로드
export HF_HUB_DISABLE_XET=1
hf download KORMo-VL/$MODEL --local-dir ~/models/$MODEL

# 4. 서버 실행 (이 터미널은 계속 실행 상태로 유지해야합니다)
vllm-mlx serve ~/models/$MODEL --port 8010 \
  --served-model-name KORMo-VL/$MODEL \
  --enable-auto-tool-choice --tool-call-parser auto
```

`--served-model-name`은 확장 프로그램이 요청할 모델 이름입니다. 빼면 내려받은 폴더 경로가 모델 이름으로 등록되어, 확장 프로그램의 요청이 404로 실패합니다. vllm-mlx 0.6.0 이상은 이미지 모델을 스스로 알아보므로 `--mllm`을 붙이지 않아도 됩니다(그보다 낮은 버전은 `--mllm`이 필요합니다).

4비트 모델(`KORMo-Web-4B-mlx-4bit`)을 고르셨다면 확장 프로그램 설정을 바꿀 필요가 없습니다. 4B나 9B 원본을 고르셨다면 2단계 설치 뒤 **개발자 설정**의 **모델 이름**을 `KORMo-VL/KORMo-Web-4B` 또는 `KORMo-VL/KORMo-Web-9B`로 바꿔 주세요(아래 [맥에서 4B·9B 원본을 쓰시는 경우](#맥에서-4b9b-원본을-쓰시는-경우)).

마지막 명령은 종료되지 않고 계속 실행된 상태로 남아 있습니다. 이 터미널은 그대로 두시고 새 터미널을 여시면 됩니다.

### 방법 2. GPU 서버에서 실행하기 (vLLM)

양자화하지 않은 원본 모델을 그대로 사용합니다. 4B, 9B, 11B 중에서 선택하시면 됩니다.

```bash
pip install vllm

vllm serve KORMo-VL/KORMo-Web-9B \
  --host 0.0.0.0 --port 8000 \
  --served-model-name KORMo-Web-9B \
  --mm-encoder-tp-mode data \
  --mm-processor-cache-type shm \
  --gdn-prefill-backend triton
```

### 서버가 떴는지 확인하기

새 터미널에서 다음 명령을 실행합니다.

```bash
curl -m 5 http://localhost:8010/v1/models
```

모델 이름이 담긴 JSON이 돌아오면 서버가 정상적으로 실행된 것입니다. 여기 나온 `id`가 확장 프로그램에 넣을 모델 이름입니다. 아무 응답 없이 멈추거나 연결이 거부된다면 서버를 띄운 터미널의 로그를 확인해 주세요. 포트를 바꾸셨거나 GPU 서버에서 띄우셨다면 주소와 포트를 그에 맞게 바꾸어 실행하시면 됩니다.

## 2단계. 크롬 확장 프로그램 설치

저장소를 내려받습니다.

```bash
git clone https://github.com/MLP-Lab/KORMo-Web-Extension.git
```

그다음 크롬에서 다음 순서로 설치합니다.

1. 주소창에 `chrome://extensions` 를 입력합니다.
2. 오른쪽 위 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 방금 클론한 `KORMo-Web-Extension` 폴더를 선택합니다.
5. 크롬 도구 모음의 확장 프로그램 메뉴에서 **GUI 에이전트**를 누르면 오른쪽에 패널이 열립니다.

패널의 작업 칸에 지시를 입력하고 **실행**을 누르면 에이전트가 동작합니다.

### 맥에서 4B·9B 원본을 쓰시는 경우

1단계 방법 1에서 `KORMo-Web-4B`나 `KORMo-Web-9B`를 고르셨다면, 패널 아래쪽 **개발자 설정**에서 **모델 이름**만 `--served-model-name`으로 지정하신 이름(`KORMo-VL/KORMo-Web-4B` 또는 `KORMo-VL/KORMo-Web-9B`)으로 바꿔 주세요. 서버 기본 URL(`http://localhost:8010/v1`)과 **tool_choice**(`auto`)는 그대로 두시면 됩니다.

### GPU 서버를 사용하시는 경우

1단계에서 방법 2를 선택하셨다면, 실행하시기 전에 패널 아래쪽 **개발자 설정**에서 다음 세 가지를 바꿔 주셔야 합니다. 방법 1에서 4비트 모델로 진행하셨다면 기본값 그대로 두시면 됩니다.

1. **서버 기본 URL**을 해당 서버 주소로 바꿉니다. `/v1`까지 입력합니다.
2. **모델 이름**을 `--served-model-name`으로 지정하신 이름으로 바꿉니다.
3. **tool_choice**를 `none`으로 바꿉니다. 같은 값이 두 서버에서 반대로 동작하기 때문에, vllm-mlx에서는 `auto`를, vLLM에서는 `none`을 사용합니다.

## 3단계. 디스코드 봇 (선택)

디스코드 채널에서 봇을 멘션해 원격으로 작업을 시킬 수 있습니다. 클론하신 저장소로 들어가 릴레이를 실행합니다.

```bash
# Homebrew가 없다면 먼저
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"

brew install node
cd KORMo-Web-Extension
node relay/discord-relay.mjs
```

실행하시면 봇 토큰을 물어봅니다.

```
봇 토큰이 없습니다. 처음이라면 이렇게 하세요:

  1. https://discord.com/developers/applications → 신규 어플리케이션
  2. 왼쪽 봇 탭 → 토큰 초기화 → 복사
  3. 같은 화면에서 메시지 콘텐츠 인텐트(MESSAGE CONTENT INTENT)를 켜고 저장

  아래 "봇 권한"은 체크하지 않아도 됩니다. 토큰을 넣으면 필요한 권한이
  담긴 초대 링크를 이 창에 출력합니다.

봇 토큰을 붙여넣으세요:
```

안내대로 토큰을 만들어 붙여넣으시면 설정 파일은 스크립트가 직접 만듭니다. JSON을 직접 작성하실 필요는 없습니다.

토큰이 확인되면 터미널에 초대 링크가 출력됩니다. 이어서 다음 순서로 연결합니다.

1. 디스코드에서 봇에게 명령을 보낼 채널을 하나 만듭니다.
2. 터미널에 출력된 초대 링크를 열어, 그 채널이 있는 서버에 봇을 추가합니다.
3. 크롬 사이드 패널에서 **개발자 설정 → 디스코드 원격 명령 → 원격 명령 받기**를 켭니다.

이제 그 채널에서 봇을 멘션하시면 멘션한 문장이 작업으로 실행되고, 결과가 같은 채널로 돌아옵니다.

## 설정

패널 아래쪽 **개발자 설정**을 펼치면 서버 기본 URL과 모델 이름을 확인하실 수 있습니다. 기본값은 다음과 같고, 방법 1에서 4비트 모델로 진행하셨다면 그대로 두시면 됩니다.

- 서버 기본 URL: `http://localhost:8010/v1`
- 모델 이름: `KORMo-VL/KORMo-Web-4B-mlx-4bit`

기본값은 4B를 MLX로 4비트 양자화한 모델입니다. 양자화하지 않은 원본은 다음 세 가지입니다.

- `KORMo-VL/KORMo-Web-4B` (맥 24GB 이상 또는 GPU 서버)
- `KORMo-VL/KORMo-Web-9B` (맥 48GB 이상 또는 GPU 서버)
- `KORMo-VL/KORMo-Web-11B` (GPU 서버)

다른 모델을 쓰실 때는 **모델 이름**을 서버에서 `--served-model-name`으로 지정한 이름과 똑같이 맞춰 주세요. **tool_choice**는 맥(vllm-mlx)에서는 `auto`, GPU 서버(vLLM)에서는 `none`입니다.
