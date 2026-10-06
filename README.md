# Lingua 1.0.0

Online release: **1.0.0** (2026-10-06).

Lingua provides browser-based real-time speech recognition and sentence translation. Gemini Live transcribes microphone audio; final transcript segments are translated by the provider and model selected in Settings. Gemini uses `gemma-4-26b-a4b-it` by default.

## Included

- Live transcription with interim and final text, using mono 16 kHz PCM audio and a short-lived Gemini token.
- Sentence translation in configurable source and target languages, with batched requests and visible errors.
- Persistent provider settings and API keys on the server. Settings are stored at `~/.config/lingua/settings.json` with directory mode `0700` and file mode `0600`; environment API keys take precedence. The file is not encrypted at rest and is readable by the service user and root.
- End-to-end translation timing records in `logs/diagnostics.jsonl`; records contain timing and model metadata, not recognized text. Optional `?debugSpeech=1` diagnostics can include recognized speech.
- GitHub Actions deployment to EC2 with service restart and health check.

## Current limits

- Microphone audio is streamed from the browser directly to Gemini Live. The service does not relay or retain audio.
- Conversation history is not persisted, and there is no account or access-control system.
- Phone audience broadcast and the M1 event/materials workflow are not included.
- Microphone capture requires a secure browser context: `localhost` for local use or HTTPS in production.

A browser-based demo for real-time speech recognition and translation. Translation requests are sent through the local Node.js service to the model provider selected in Settings.

## Run locally

Requires Node.js 18 or later. No additional npm dependencies are needed.

```sh
node server.js
```

Then open <http://127.0.0.1:4173/>, choose Gemini in Settings, and save a Gemini API key. Click Start speaking and grant microphone access. This version uses Gemini Live transcription over WebSocket; see the [official Live transcription guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) and [ephemeral token guide](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens).

## Diagnostics

Translation timing is always written to `logs/diagnostics.jsonl` without transcript text. Each completed or failed translation records end-to-end time from the first voiced audio frame detected in the browser through receipt of the translation, plus ASR and translation-request durations, language direction, provider, and model. Enable additional speech diagnostics with `?debugSpeech=1`; those logs may contain recognized speech. The `logs/` directory is excluded by `.gitignore` and is not included in the repository.

## GitHub Actions 部署到 EC2

`.github/workflows/deploy-ec2.yml` 会在 pull request 和推送到 `main` 时检查 JavaScript 语法；只有 `main` 检查通过后才会部署。部署使用 SSH 同步文件、重启 EC2 上的 systemd 服务，并请求 `http://127.0.0.1:4173/healthz` 验证启动。

### EC2 首次配置

在 EC2 上安装 Node.js 18 或更新版本、`rsync`，创建专用部署用户及应用目录。确保该用户可以写入部署目录，并可通过 sudo 无密码执行指定服务的 `systemctl restart`、`systemctl is-active` 和 `systemctl status`。例如为服务名 `lingua` 配置 sudoers：

```sudoers
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart lingua, /usr/bin/systemctl is-active --quiet lingua, /usr/bin/systemctl status lingua --no-pager
```

将 systemd unit 安装为 `/etc/systemd/system/lingua.service`（按实际用户和目录调整）：

```ini
[Unit]
Description=Lingua translation service
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/lingua
ExecStart=/usr/bin/node /opt/lingua/server.js
Restart=on-failure
Environment=PORT=4173

[Install]
WantedBy=multi-user.target
```

创建目录并启用服务：

```sh
sudo mkdir -p /opt/lingua
sudo chown deploy:deploy /opt/lingua
sudo systemctl daemon-reload
sudo systemctl enable lingua
```

Gemini API key 由应用设置保存在服务用户主目录下的 `~/.config/lingua/settings.json`，目录权限为 `0700`、文件权限为 `0600`；设置文件位于应用部署目录之外，不会被部署同步覆盖。该文件在磁盘上未加密，能登录该服务用户或 root 的人员可以读取。不要提交 API key 或设置文件到仓库。麦克风采集要求安全上下文：本地可使用 `localhost`，生产环境应配置 HTTPS。

### GitHub 配置

在仓库 **Settings → Secrets and variables → Actions** 中添加以下 Repository secrets：

| 名称 | 内容 |
| --- | --- |
| `EC2_HOST` | EC2 公网 DNS 名称或 IP |
| `EC2_USER` | 专用 SSH 部署用户名 |
| `EC2_SSH_PRIVATE_KEY` | 对应部署公钥已写入 EC2 `authorized_keys` 的私钥 |
| `EC2_KNOWN_HOSTS` | EC2 SSH 主机公钥记录（从可信渠道核验后提供） |

添加以下 Repository variables：

| 名称 | 内容 |
| --- | --- |
| `EC2_DEPLOY_PATH` | 应用目录，例如 `/opt/lingua` |
| `EC2_SERVICE_NAME` | systemd 服务名，例如 `lingua` |

首次部署只会在推送到 `main` 且检查通过后运行。请确保 Actions runner 能通过 SSH 访问 EC2，且实例的本地健康检查地址为 `127.0.0.1:4173/healthz`。
